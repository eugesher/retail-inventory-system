# Retail Inventory System

A microservices-based retail inventory management API built with NestJS, RabbitMQ, and MySQL.

## Overview

The system handles order lifecycle management and product stock tracking across a distributed architecture. Clients interact with a single HTTP API gateway, which delegates work to specialized microservices over RabbitMQ.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                       Client (HTTP)                       │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  API Gateway port: 3000                   │
│                                                           │
│  POST  /api/orders                                        │
│  PUT   /api/orders/:id/confirm                            │
│  GET   /product/:productId/stock                          │
└──────────────┬──────────────────────────────┬─────────────┘
               │           RabbitMQ           │
      RPC      │                              │     RPC
┌──────────────▼─────────┐  ┌─────────────────▼─────────────┐
│  Retail Microservice   │  │    Inventory Microservice     │
│                        │  │                               │
│  RETAIL_ORDER_CREATE   │  │  INVENTORY_PRODUCT_STOCK_GET  │
│  RETAIL_ORDER_CONFIRM  │  │                               │
│                        │  │  Listens:                     │
│  Emits:                │  │  RETAIL_ORDER_CREATED         │
│  RETAIL_ORDER_CREATED ─┼───► (stock reservation)          │
└──────────────┬─────────┘  └─────────────────┬─────────────┘
               │                              │
               │            MySQL             │
               └──────────────┬───────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                         Retail DB                         │
│                                                           │
│  order                                                    │
│  order_product                                            │
│  product_stock                                            │
└───────────────────────────────────────────────────────────┘
```

## Services

| Service | Transport | Responsibility |
|---|---|---|
| `api-gateway` | HTTP (port 3000) | Single entry point; routes requests to microservices |
| `retail-microservice` | RabbitMQ (`retail_queue`) | Order creation and confirmation |
| `inventory-microservice` | RabbitMQ (`inventory_queue`) | Stock queries and reservation |
| `notification-microservice` | RabbitMQ (`notification_queue`) | Stub (not yet implemented) |

## Getting Started

Start the infrastructure and all services:

```bash
docker-compose up -d mysql redis rabbitmq
yarn migration:run
yarn start:dev
```

## API

### Orders

```
POST /api/orders
PUT  /api/orders/:id/confirm
```

### Stock

```
GET /product/:productId/stock
```

Interactive API reference is available at `http://localhost:3000/api/reference` when the gateway is running.
