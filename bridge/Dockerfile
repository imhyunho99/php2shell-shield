FROM node:22-alpine
WORKDIR /app
COPY package.json README.md ./
COPY src ./src
COPY bin ./bin
RUN ln -s /app/bin/php-bridge.js /usr/local/bin/php-bridge
USER node
ENTRYPOINT ["php-bridge"]
