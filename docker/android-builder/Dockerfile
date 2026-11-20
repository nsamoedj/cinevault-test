# The Android build environment of scripts/build-apk.ps1: Node 22 with pnpm
# (corepack), Java 17 and Google's Android command-line tools. Gradle installs
# the SDK platform, build tools and NDK the app asks for into /opt/android-sdk,
# a Docker volume, so they are downloaded once.
FROM node:22-bookworm

ARG CMDLINE_TOOLS=11076708

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jdk-headless unzip git \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_OPTIONS=--max-old-space-size=4096
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

RUN mkdir -p "$ANDROID_HOME/cmdline-tools" \
  && curl -fsSL -o /tmp/tools.zip \
    "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS}_latest.zip" \
  && unzip -q /tmp/tools.zip -d /tmp/tools \
  && mv /tmp/tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
  && rm -rf /tmp/tools /tmp/tools.zip \
  && (yes | sdkmanager --licenses > /dev/null) \
  && sdkmanager --install platform-tools > /dev/null

RUN corepack enable

WORKDIR /work
