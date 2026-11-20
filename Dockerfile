# VetMCP в контейнере: запуск stdio-сервера под Node 20.
# Используется при листинге в Glama (проверка «сервер стартует и отвечает
# на introspection») и для любого контейнерного запуска:
#   docker build -t vetmcp . && docker run -i --rm vetmcp
FROM node:20-slim
WORKDIR /app
COPY vetmcp.mjs .
CMD ["node", "vetmcp.mjs"]
