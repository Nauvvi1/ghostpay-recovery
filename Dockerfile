FROM node:22-bookworm-slim
WORKDIR /srv/ghostpay
COPY package.json README.md ./
COPY apps/ ./apps/
COPY sdk/ ./sdk/
ENV HOST=0.0.0.0 PORT=4173 PAYMENT_MODE=demo GHOSTPAY_DB=/srv/ghostpay/data/ghostpay.sqlite
EXPOSE 4173
VOLUME ["/srv/ghostpay/data"]
CMD ["npm","run","start"]
