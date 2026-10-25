const REPORT_INTERVAL_MS = 10_000;
const MAX_SIGNATURES = 512;
const MAX_LOG_BYTES = 64 * 1024 * 1024;

interface RepeatedLine {
  label: string;
  seen: number;
  suppressed: number;
  lastReportAt: number;
  lastSeenAt: number;
}

function verboseSignature(line: string): { key: string; label: string } | null {
  const match = line.match(/(?:^|:)(fixme|info|trace):([^:]+):(.+)$/i);
  if (!match) return null;
  const detail = match[3].replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<address>');
  const key = `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${detail}`;
  return { key, label: key.slice(0, 120) };
}

export function gameLoggingEnvironment(source: NodeJS.ProcessEnv, verbose = false): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (verbose) environment.XODUS_NEXUS_VERBOSE_LOGS = '1';
  if (environment.XODUS_NEXUS_VERBOSE_LOGS === '1') return environment;
  environment.WINEDEBUG ??= '-fixme';
  environment.VKD3D_DEBUG ??= 'warn';
  environment.VKD3D_SHADER_DEBUG ??= 'warn';
  return environment;
}

// A game is a separate desktop application. Do not pass Electron's startup
// notification or desktop-file identity through Xodus into Wine/Proton.
export function gameWindowEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of [
    'DESKTOP_STARTUP_ID', 'XDG_ACTIVATION_TOKEN', 'XDG_DESKTOP_FILE_NAME',
    'GIO_LAUNCHED_DESKTOP_FILE', 'GIO_LAUNCHED_DESKTOP_FILE_PID',
    'BAMF_DESKTOP_FILE_HINT', 'CHROME_DESKTOP', 'APPDIR', 'APPIMAGE',
  ]) delete environment[key];
  return environment;
}

export class GameLogReducer {
  private readonly repeated = new Map<string, RepeatedLine>();
  // Shared slot for signatures that arrive while every slot was used within
  // the last report interval, so a working set larger than the map still
  // collapses instead of thrashing through eviction.
  private readonly overflow: RepeatedLine = { label: `diagnostics beyond ${MAX_SIGNATURES} distinct signatures`, seen: 0, suppressed: 0, lastReportAt: 0, lastSeenAt: 0 };

  constructor(
    private readonly write: (line: string) => void,
    private readonly verbose = false,
    private readonly now: () => number = Date.now,
  ) {
    this.overflow.lastReportAt = now();
  }

  push(line: string): void {
    const signature = this.verbose ? null : verboseSignature(line);
    if (!signature) {
      this.write(line);
      return;
    }
    // Map insertion order doubles as recency order: re-inserting a seen
    // signature moves it to the end, so the first entry is the coldest one.
    let entry = this.repeated.get(signature.key);
    if (entry) {
      this.repeated.delete(signature.key);
    } else if (this.repeated.size < MAX_SIGNATURES || this.evictStale()) {
      entry = { label: signature.label, seen: 0, suppressed: 0, lastReportAt: this.now(), lastSeenAt: 0 };
    } else {
      this.count(this.overflow, line);
      return;
    }
    this.repeated.set(signature.key, entry);
    this.count(entry, line);
  }

  flush(): void {
    for (const entry of this.repeated.values()) this.report(entry);
    this.report(this.overflow);
  }

  private count(entry: RepeatedLine, line: string): void {
    entry.seen += 1;
    entry.lastSeenAt = this.now();
    if (entry.seen <= 2) {
      this.write(line);
      return;
    }
    entry.suppressed += 1;
    if (this.now() - entry.lastReportAt >= REPORT_INTERVAL_MS) this.report(entry);
  }

  private evictStale(): boolean {
    const [key, entry] = this.repeated.entries().next().value!;
    if (this.now() - entry.lastSeenAt < REPORT_INTERVAL_MS) return false;
    this.report(entry);
    this.repeated.delete(key);
    return true;
  }

  private report(entry: RepeatedLine): void {
    if (entry.suppressed === 0) return;
    this.write(`Suppressed ${entry.suppressed} repeated ${entry.label} diagnostic lines. Enable verbose logs in Settings or set XODUS_NEXUS_VERBOSE_LOGS=1 for full output.`);
    entry.suppressed = 0;
    entry.lastReportAt = this.now();
  }
}

// Backstop against any spam source the reducer does not recognise: past
// maxBytes the file keeps only the last tailLines lines, written on end(), so
// the exit code and final summaries still reach it.
export class CappedLog {
  private written = 0;
  private omitted = 0;
  private capped = false;
  private readonly tail: string[] = [];

  constructor(
    private readonly write: (text: string) => void,
    private readonly maxBytes = MAX_LOG_BYTES,
    private readonly tailLines = 200,
  ) {}

  push(text: string): void {
    if (!this.capped) {
      this.written += Buffer.byteLength(text);
      if (this.written <= this.maxBytes) {
        this.write(text);
        return;
      }
      this.capped = true;
      this.write(`Log size limit of ${Math.round(this.maxBytes / 1024 / 1024)} MB reached; only the last ${this.tailLines} lines of further output will be written when the game exits. Enable verbose logs in Settings or set XODUS_NEXUS_VERBOSE_LOGS=1 for full output.\n`);
    }
    this.tail.push(text);
    if (this.tail.length > this.tailLines) {
      this.tail.shift();
      this.omitted += 1;
    }
  }

  end(): void {
    if (!this.capped) return;
    this.write(`Omitted ${this.omitted} lines over the log size limit; the last ${this.tail.length} follow.\n`);
    for (const text of this.tail.splice(0)) this.write(text);
    this.omitted = 0;
  }
}
