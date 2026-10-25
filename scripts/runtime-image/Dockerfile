# The verified runtime as an image, so direwolf can pin it by digest in ArgoCD and
# install it with an initContainer (install-runtime.sh). runtime.yml unpacks the
# candidate tarball into runtime/ beside this file before building.
FROM busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092
COPY --chown=1000:1000 runtime/ /runtime/
COPY install-runtime.sh /usr/local/bin/install-runtime
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/install-runtime"]
