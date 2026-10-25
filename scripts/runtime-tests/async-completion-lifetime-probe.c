/* Regression: the GDK permits deleting/reusing XAsyncBlock in completion.
 * No Xbox identity, game files, network, or save data is used. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <stdio.h>
#include "xtaskqueue.h"
#include "xasyncprovider.h"

static IXThreadingImpl *threads;
static XTaskQueueHandle queue;
static LONG callbacks, cleanups, checks, failures, canceled_callbacks;
static HRESULT outcome;
static SIZE_T payload;
static BOOL consume, reuse;
#define CHECK(x) do { checks++; if (!(x)) { failures++; printf("FAIL %d\n", __LINE__); } } while (0)

static HRESULT WINAPI provider(XAsyncOp op, const XAsyncProviderData *data)
{
    if (op == XAsyncOp_GetResult && data->buffer) *(DWORD *)data->buffer = 0x12345678;
    if (op == XAsyncOp_Cleanup) InterlockedIncrement(&cleanups);
    return S_OK;
}

static void WINAPI completed(XAsyncBlock *block)
{
    DWORD result = 0;
    CHECK(IXThreadingImpl_XAsyncGetStatus(threads, block, FALSE) == outcome);
    if (consume) {
        CHECK(IXThreadingImpl_XAsyncGetResult(threads, block, NULL, sizeof(result), &result, NULL) == S_OK);
        CHECK(result == 0x12345678);
    }
    InterlockedIncrement(&callbacks);
    if (reuse) {
        /* A new state must not make the old completion clean it by mistake. */
        /* Native XAsync snapshots callback at Begin. Set it for the next
         * operation before Begin, not after it has already been captured. */
        block->callback = NULL;
        CHECK(IXThreadingImpl_XAsyncBegin(threads, block, NULL, NULL, "reused", provider) == S_OK);
    } else {
        CHECK(VirtualFree(block, 0, MEM_RELEASE));
    }
}

/* Native XAsync lets canceled completions through so titles can free the
 * per-call context they own; the completed status is preserved. */
static void WINAPI canceled_completed(XAsyncBlock *block)
{
    CHECK(IXThreadingImpl_XAsyncGetStatus(threads, block, FALSE) == S_OK);
    InterlockedIncrement(&canceled_callbacks);
    CHECK(VirtualFree(block, 0, MEM_RELEASE));
}

/* Native XAsync holds a queue termination suspension per operation, so
 * Terminate waits for outstanding calls: completions arriving after it still
 * reach the title's callback, and only then is termination reported. */
static LONG term_callbacks, term_notified, term_callbacks_at_notify, term_work;
static HRESULT term_status;

static void WINAPI term_completed(XAsyncBlock *block)
{
    term_status = IXThreadingImpl_XAsyncGetStatus(threads, block, FALSE);
    InterlockedIncrement(&term_callbacks);
}

static void CALLBACK term_finished(void *context)
{
    term_callbacks_at_notify = term_callbacks;
    InterlockedIncrement(&term_notified);
}

static HRESULT WINAPI scheduling_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    if (op == XAsyncOp_Begin) return IXThreadingImpl_XAsyncSchedule(threads, data->async, 0);
    if (op == XAsyncOp_DoWork) {
        InterlockedIncrement(&term_work);
        IXThreadingImpl_XAsyncComplete(threads, data->async, S_OK, 0);
    }
    return S_OK;
}

/* Begin succeeds and the operation stays in flight until completed later. */
static HRESULT WINAPI in_flight_provider(XAsyncOp op, const XAsyncProviderData *data)
{
    return S_OK;
}

static HRESULT WINAPI counted_work(XAsyncBlock *block)
{
    InterlockedIncrement(&term_work);
    return S_OK;
}

static void pump(XTaskQueueHandle target)
{
    int i;
    for (i = 0; i < 8; i++) {
        IXThreadingImpl_XTaskQueueDispatch(threads, target, XTaskQueuePort_Work, 0);
        IXThreadingImpl_XTaskQueueDispatch(threads, target, XTaskQueuePort_Completion, 0);
    }
}

enum term_case { SCHEDULED, RUN, IN_FLIGHT, AFTER_TERMINATE };

static void manual_termination(enum term_case kind)
{
    XTaskQueueHandle target = NULL;
    XAsyncBlock block = {0};
    term_callbacks = term_notified = term_callbacks_at_notify = term_work = 0;
    term_status = E_PENDING;
    CHECK(IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &target) == S_OK);
    block.queue = target;
    block.callback = term_completed;
    if (kind == AFTER_TERMINATE) {
        /* A terminated queue accepts no new operations and calls nothing back. */
        CHECK(IXThreadingImpl_XTaskQueueTerminate(threads, target, FALSE, NULL, term_finished) == S_OK);
        CHECK(IXThreadingImpl_XAsyncBegin(threads, &block, NULL, NULL, "late", in_flight_provider) == E_ABORT);
        CHECK(IXThreadingImpl_XAsyncRun(threads, &block, counted_work) == E_ABORT);
        pump(target);
        CHECK(term_callbacks == 0 && term_work == 0 && term_notified == 1);
        IXThreadingImpl_XTaskQueueCloseHandle(threads, target);
        return;
    }
    if (kind == SCHEDULED) CHECK(IXThreadingImpl_XAsyncBegin(threads, &block, NULL, NULL, "scheduled", scheduling_provider) == S_OK);
    if (kind == RUN) CHECK(IXThreadingImpl_XAsyncRun(threads, &block, counted_work) == S_OK);
    if (kind == IN_FLIGHT) CHECK(IXThreadingImpl_XAsyncBegin(threads, &block, NULL, NULL, "in-flight", in_flight_provider) == S_OK);
    /* Terminate before the queued work is dispatched. */
    CHECK(IXThreadingImpl_XTaskQueueTerminate(threads, target, FALSE, NULL, term_finished) == S_OK);
    if (kind == IN_FLIGHT) {
        pump(target);
        CHECK(term_notified == 0);
        IXThreadingImpl_XAsyncComplete(threads, &block, S_OK, 0);
    }
    pump(target);
    CHECK(term_work == 0);
    CHECK(term_callbacks == 1);
    CHECK(term_status == (kind == IN_FLIGHT ? S_OK : E_ABORT));
    CHECK(term_notified == 1);
    CHECK(term_callbacks_at_notify == 1);
    CHECK(IXThreadingImpl_XAsyncGetStatus(threads, &block, TRUE) == term_status);
    IXThreadingImpl_XTaskQueueCloseHandle(threads, target);
}

#define POOL_CALLS 2000
static XAsyncBlock pool_blocks[POOL_CALLS];

static DWORD WINAPI completer(void *arg)
{
    int i;
    for (i = 0; i < POOL_CALLS; i++) IXThreadingImpl_XAsyncComplete(threads, &pool_blocks[i], S_OK, 0);
    return 0;
}

/* Terminate(wait=TRUE) on thread-pool ports returns only after every
 * outstanding operation has called back, whether it raced a completer
 * thread or had its queued work canceled. */
static void pool_termination(BOOL in_flight)
{
    XTaskQueueHandle target = NULL;
    HANDLE thread = NULL;
    int i, calls = in_flight ? POOL_CALLS : POOL_CALLS / 2;
    term_callbacks = term_notified = term_callbacks_at_notify = term_work = 0;
    memset(pool_blocks, 0, sizeof(pool_blocks));
    CHECK(IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_ThreadPool, XTaskQueueDispatchMode_ThreadPool, &target) == S_OK);
    for (i = 0; i < calls; i++) {
        pool_blocks[i].queue = target;
        pool_blocks[i].callback = term_completed;
        if (in_flight) CHECK(IXThreadingImpl_XAsyncBegin(threads, &pool_blocks[i], NULL, NULL, "pool", in_flight_provider) == S_OK);
        else CHECK(IXThreadingImpl_XAsyncRun(threads, &pool_blocks[i], counted_work) == S_OK);
    }
    if (in_flight) CHECK((thread = CreateThread(NULL, 0, completer, NULL, 0, NULL)) != NULL);
    CHECK(IXThreadingImpl_XTaskQueueTerminate(threads, target, TRUE, NULL, term_finished) == S_OK);
    CHECK(term_callbacks == calls);
    CHECK(term_notified == 1);
    CHECK(term_callbacks_at_notify == calls);
    if (!in_flight) CHECK(term_work <= calls);
    if (thread) {
        CHECK(WaitForSingleObject(thread, 30000) == WAIT_OBJECT_0);
        CloseHandle(thread);
    }
    IXThreadingImpl_XTaskQueueCloseHandle(threads, target);
}

int main(int argc, char **argv)
{
    HRESULT (WINAPI *query)(const GUID *, REFIID, void **);
    HMODULE dll = LoadLibraryA(argc > 1 ? argv[1] : "xgameruntime.dll");
    int i;
    if (!dll) { printf("DLL load failed %lu\n", GetLastError()); return 1; }
    query = (void *)GetProcAddress(dll, "QueryApiImpl");
    CHECK(query != NULL);
    if (!query) return 1;
    CHECK(query(&CLSID_XThreadingImpl, &IID_IXThreadingImpl, (void **)&threads) == S_OK);
    CHECK(IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &queue) == S_OK);
    for (i = 0; i < 400; i++) {
        LONG before = cleanups;
        XAsyncBlock *block = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        CHECK(block != NULL);
        if (!block) return 1;
        outcome = i % 4 == 0 ? E_FAIL : S_OK;
        payload = i % 4 == 2 ? sizeof(DWORD) : 0;
        consume = payload != 0;
        reuse = i % 4 == 3;
        block->queue = queue;
        block->callback = completed;
        CHECK(IXThreadingImpl_XAsyncBegin(threads, block, NULL, NULL, "lifetime", provider) == S_OK);
        IXThreadingImpl_XAsyncComplete(threads, block, outcome, payload);
        CHECK(IXThreadingImpl_XTaskQueueDispatch(threads, queue, XTaskQueuePort_Completion, 0));
        CHECK(cleanups == before + 1);
        if (reuse) {
            block->callback = NULL;
            IXThreadingImpl_XAsyncComplete(threads, block, S_OK, 0);
            CHECK(cleanups == before + 2);
            CHECK(VirtualFree(block, 0, MEM_RELEASE));
        }
    }
    CHECK(callbacks == 400);
    CHECK(cleanups == 500);
    {
        XTaskQueueHandle terminated = NULL;
        XAsyncBlock *block = VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        CHECK(block != NULL);
        if (!block) return 1;
        CHECK(IXThreadingImpl_XTaskQueueCreate(threads, XTaskQueueDispatchMode_Manual, XTaskQueueDispatchMode_Manual, &terminated) == S_OK);
        block->queue = terminated;
        block->callback = canceled_completed;
        CHECK(IXThreadingImpl_XAsyncBegin(threads, block, NULL, NULL, "canceled", provider) == S_OK);
        IXThreadingImpl_XAsyncComplete(threads, block, S_OK, 0);
        /* Terminate before the queued completion is dispatched: it runs canceled. */
        CHECK(IXThreadingImpl_XTaskQueueTerminate(threads, terminated, FALSE, NULL, NULL) == S_OK);
        for (i = 0; i < 4; i++) IXThreadingImpl_XTaskQueueDispatch(threads, terminated, XTaskQueuePort_Completion, 0);
        CHECK(canceled_callbacks == 1);
        CHECK(cleanups == 501);
        IXThreadingImpl_XTaskQueueCloseHandle(threads, terminated);
    }
    manual_termination(SCHEDULED);
    manual_termination(RUN);
    manual_termination(IN_FLIGHT);
    manual_termination(AFTER_TERMINATE);
    pool_termination(TRUE);
    pool_termination(FALSE);
    IXThreadingImpl_XTaskQueueCloseHandle(threads, queue);
    IXThreadingImpl_Release(threads);
    printf("ASYNC CHECKS %ld FAILURES %ld CALLBACKS %ld CANCELED %ld CLEANUPS %ld\n", checks, failures, callbacks, canceled_callbacks, cleanups);
    return failures ? 1 : 0;
}
