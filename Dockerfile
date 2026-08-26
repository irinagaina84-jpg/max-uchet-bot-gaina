FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
ENV BOT_IMAGE_REVISION=v56-persistent-ledger-20260826-4
COPY package-final.json ./package.json
RUN npm install --omit=dev
COPY bot-giga-v14.js ./bot-giga-v14.js
COPY patch-v14-fullchat.mjs ./patch-v14-fullchat.mjs
COPY patch-v14-silent.mjs ./patch-v14-silent.mjs
COPY patch-v14-webhook.mjs ./patch-v14-webhook.mjs
COPY patch-v14-block-stale.mjs ./patch-v14-block-stale.mjs
COPY patch-v14-max-history.mjs ./patch-v14-max-history.mjs
COPY patch-v14-freshscope.mjs ./patch-v14-freshscope.mjs
COPY patch-v14-dialog-routing.mjs ./patch-v14-dialog-routing.mjs
COPY patch-v14-private-owner.mjs ./patch-v14-private-owner.mjs
COPY patch-v14-accounting-accuracy.mjs ./patch-v14-accounting-accuracy.mjs
COPY patch-v14-release-series.mjs ./patch-v14-release-series.mjs
COPY patch-v14-text-release-logic.mjs ./patch-v14-text-release-logic.mjs
COPY patch-v14-openai-brain.mjs ./patch-v14-openai-brain.mjs
COPY patch-v14-semantic-thread.mjs ./patch-v14-semantic-thread.mjs
COPY patch-v56-ledger-compat.mjs ./patch-v56-ledger-compat.mjs
COPY patch-v14-persistent-ledger-v2.mjs ./patch-v14-persistent-ledger-v2.mjs
COPY patch-v56-ledger-safety.mjs ./patch-v56-ledger-safety.mjs
RUN node patch-v14-fullchat.mjs
RUN node patch-v14-silent.mjs
RUN node patch-v14-webhook.mjs
RUN node patch-v14-block-stale.mjs
RUN node patch-v14-max-history.mjs
RUN node patch-v14-freshscope.mjs
RUN node patch-v14-dialog-routing.mjs
RUN node patch-v14-private-owner.mjs
RUN node patch-v14-accounting-accuracy.mjs
RUN node patch-v14-release-series.mjs
RUN node patch-v14-text-release-logic.mjs
RUN node patch-v14-openai-brain.mjs
RUN node patch-v14-semantic-thread.mjs
RUN node patch-v56-ledger-compat.mjs
RUN node patch-v14-persistent-ledger-v2.mjs
RUN node patch-v56-ledger-safety.mjs
RUN node --check bot.js
EXPOSE 3000
CMD ["node", "bot.js"]
