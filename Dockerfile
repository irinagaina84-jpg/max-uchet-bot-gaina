FROM node:20-bookworm-slim
WORKDIR /app
COPY russian-trusted-root-ca.pem /app/russian-trusted-root-ca.pem
ENV NODE_EXTRA_CA_CERTS=/app/russian-trusted-root-ca.pem
ENV BOT_IMAGE_REVISION=v53-text-release-logic-20260826-1
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
RUN node --check bot.js
EXPOSE 3000
CMD ["node", "bot.js"]
