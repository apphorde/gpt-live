FROM node:22-alpine
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY app ./app
USER node
EXPOSE 3000
CMD ["node", "app/server.js"]
