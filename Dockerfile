FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
COPY package-final.json ./package.json
RUN npm install --omit=dev
COPY bot-giga-v14.js ./bot-giga-v14.js
COPY patch-v14-fullchat.mjs ./patch-v14-fullchat.mjs
COPY patch-v14-silent.mjs ./patch-v14-silent.mjs
COPY patch-v14-webhook.mjs ./patch-v14-webhook.mjs
COPY patch-v14-syncchats.mjs ./patch-v14-syncchats.mjs
COPY patch-v14-freshscope.mjs ./patch-v14-freshscope.mjs
RUN node patch-v14-fullchat.mjs
RUN node patch-v14-silent.mjs
RUN node patch-v14-webhook.mjs
RUN node patch-v14-syncchats.mjs
RUN node patch-v14-freshscope.mjs
EXPOSE 3000
CMD ["node", "bot.js"]
