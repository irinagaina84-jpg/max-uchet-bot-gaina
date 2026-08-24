FROM node:20-bookworm-slim
WORKDIR /app
COPY bot-fixed.js ./bot.js
EXPOSE 3000
CMD ["node", "bot.js"]
