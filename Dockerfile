FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
COPY bot-giga-v6.js ./bot.js
COPY bot-core.js ./bot-core.js
COPY bot-giga-v5.js ./bot-giga-v5.js
EXPOSE 3000
CMD ["node", "bot.js"]
