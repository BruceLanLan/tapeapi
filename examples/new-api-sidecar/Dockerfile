# syntax=docker/dockerfile:1.7
# The TapeAPI signing sidecar for new-api: Node 22 on Alpine, @tapeapi/sdk and @tapeapi/server installed from THIS
# checkout (the named build contexts `sdk` and `server`, set in docker-compose.yml), laid out as the repository's own npm
# workspace, so the image runs exactly the code you have read. Nothing here fetches TapeAPI code from the network; npm
# fetches only the SDK's three pinned @noble dependencies.
# 给 new-api 用的 TapeAPI 签名旁路：Node 22（Alpine），@tapeapi/sdk 与 @tapeapi/server 取自**本次检出**（docker-compose.yml 里
# 的命名构建上下文 sdk 与 server），按仓库自己的 npm 工作区布局安装，镜像里运行的就是你读过的代码。这里不从网络获取任何 TapeAPI
# 代码；npm 只下载 SDK 固定版本的三个 @noble 依赖。
#
# Without compose / 不用 compose 时:
#   docker build --build-context sdk=../../sdk --build-context server=../../server -t tapeapi-new-api-sidecar:1.2.0 .
FROM node:22-alpine
WORKDIR /app
RUN printf '{"private":true,"type":"module","workspaces":["sdk","server"]}\n' > package.json
COPY --from=sdk package.json ./sdk/package.json
COPY --from=sdk src ./sdk/src
COPY --from=sdk bin ./sdk/bin
COPY --from=server package.json ./server/package.json
COPY --from=server src ./server/src
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY server.mjs ./server.mjs
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
