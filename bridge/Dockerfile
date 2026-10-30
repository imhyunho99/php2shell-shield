FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/imhyunho99/php2shell-shield" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY package.json README.md LICENSE ./
COPY src ./src
COPY bin ./bin
RUN ln -s /app/bin/php-bridge.js /usr/local/bin/php-bridge
USER node
ENTRYPOINT ["php-bridge"]
