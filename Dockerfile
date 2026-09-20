FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 本项目零 npm 依赖，无需 npm install，只复制运行时必需文件
COPY package.json ./
COPY src/ ./src/

# 容器内必须监听 0.0.0.0，否则 -p 端口映射不通
ENV HOST=0.0.0.0
ENV PORT=8787
EXPOSE 8787

# alpine 无 curl，用内置 node 探测以避免额外装包
# 注意：/healthz 为硬匹配路径，探测 URL 不能带 query string
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('node:http').get({host:'127.0.0.1',port:process.env.PORT||8787,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

USER node

# 必须用 exec 形式直接调 node，不能用 npm start：
# npm 作为 PID 1 不转发信号，会使 src/index.js 中的优雅停机失效
CMD ["node", "src/index.js"]
