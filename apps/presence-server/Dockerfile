FROM node:20-alpine
WORKDIR /app
COPY src ./src
COPY package.json ./package.json
EXPOSE 8787
CMD ["node", "src/server.mjs"]
