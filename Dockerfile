FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
COPY package-final.json ./package.json
RUN npm install --omit=dev
COPY bot-giga-v14.js ./bot-giga-v14.js
COPY patch-v14-money.mjs ./patch-v14-money.mjs
RUN node patch-v14-money.mjs
EXPOSE 3000
CMD ["node", "bot.js"]
