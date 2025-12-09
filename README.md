# OpenTelemetry AMQP Baggage Propagation Example

This example demonstrates OpenTelemetry auto-instrumentation with baggage propagation across AMQP (RabbitMQ) message queues in Node.js.

## Overview

The example consists of two services:

1. **Publisher Service** - Publishes messages to a RabbitMQ queue with OpenTelemetry baggage
2. **Consumer Service** - Consumes messages from the queue and injects baggage into HTTP requests for the `api-service`
3. **API Service** - Receives HTTP requests from the consumer including baggage

## Prerequisites

- Docker and Docker Compose
- Node.js 20 or higher (for local development)

## How to Run

### Using Docker Compose (Recommended)

```bash
docker compose up --build
```
