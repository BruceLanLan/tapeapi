# syntax=docker/dockerfile:1.7
# The TapeAPI signing sidecar for LiteLLM Proxy: Node 22 on Alpine, @tapeapi/sdk and @tapeapi/server installed from THIS
# checkout (the named build contexts `sdk` and `server`), plus the two entry files it runs: the new-api package's
# (examples/new-api-sidecar/server.mjs, context `newapi`), which does the work, and this package's server.mjs, which
# gives it LiteLLM's profile. They sit at their repository paths, so the image runs exactly the code you have read.
# Nothing here fetches TapeAPI code from the network; npm fetches only the SDK's three pinned @noble dependencies.
# 给 LiteLLM Proxy 用的 TapeAPI 签名旁路：Node 22（Alpine），@tapeapi/sdk 与 @tapeapi/server 取自**本次检出**（命名构建上下文
# sdk 与 server），外加它运行的两个入口文件：new-api 一键包的 server.mjs（上下文 newapi，真正干活的那个）和本包的 server.mjs
# （给它换上 LiteLLM 的配置）。两个文件放在与仓库相同的路径上，镜像里运行的就是你读过的代码。npm 只下载 SDK 固定版本的三个 @noble 依赖。
#
# Without compose / 不用 compose 时:
#   docker build --build-context sdk=../../sdk --build-context server=../../server \
#     --build-context newapi=../new-api-sidecar -t tapeapi-litellm-sidecar:1.7.0 .
FROM node:22-alpine
WORKDIR /app
RUN printf '{"private":true,"type":"module","workspaces":["sdk","server"]}\n' > package.json
COPY --from=sdk package.json ./sdk/package.json
COPY --from=sdk src ./sdk/src
COPY --from=sdk bin ./sdk/bin
COPY --from=server package.json ./server/package.json
COPY --from=server src ./server/src
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=newapi server.mjs ./examples/new-api-sidecar/server.mjs
COPY server.mjs ./examples/litellm-sidecar/server.mjs
WORKDIR /app/examples/litellm-sidecar
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
