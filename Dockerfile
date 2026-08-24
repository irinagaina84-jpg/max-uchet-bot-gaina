FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
COPY package-final.json ./package.json
RUN npm install --omit=dev
COPY bot-giga-v13.js ./bot.js
EXPOSE 3000
CMD ["node", "bot.js"]
