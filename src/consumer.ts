import * as amqp from 'amqplib';
import type * as amqpTypes from 'amqplib';
import * as api from '@opentelemetry/api';
import * as http from 'http';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const QUEUE_NAME = 'otel-baggage-demo';
const API_SERVICE_URL = process.env.API_SERVICE_URL || 'http://localhost:3000';

interface Message {
  id: number;
  timestamp: string;
  data: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectWithRetry(maxRetries: number = 10, delayMs: number = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connecting to RabbitMQ at ${RABBITMQ_URL}... (attempt ${attempt}/${maxRetries})`);
      const connection = await amqp.connect(RABBITMQ_URL);
      console.log('✅ Connected to RabbitMQ successfully!');
      return connection;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      console.log(`⚠️  Connection failed, retrying in ${delayMs / 1000}s...`);
      await sleep(delayMs);
    }
  }
  throw new Error('Failed to connect to RabbitMQ');
}

async function consumeMessages(): Promise<void> {
  let connection;
  let channel: any;

  try {
    // Connect to RabbitMQ with retry logic
    connection = await connectWithRetry();
    channel = await connection.createChannel();

    // Declare the queue
    await channel.assertQueue(QUEUE_NAME, { durable: false });
    console.log(`Queue '${QUEUE_NAME}' is ready`);
    console.log('Waiting for messages... (Press Ctrl+C to exit)\n');

    // Consume messages
    // The auto-instrumentation will automatically extract trace context and baggage
    await channel.consume(QUEUE_NAME, (msg: amqpTypes.ConsumeMessage | null) => {
      if (msg !== null) {
        processMessage(msg, channel);
      }
    });

  } catch (error) {
    console.error('Error in consumer:', error);
    if (channel) await channel.close().catch(() => { });
    if (connection) await connection.close().catch(() => { });
    process.exit(1);
  }
}

async function callApiService(messageContent: Message, currentBaggage: api.Baggage | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL('/process', API_SERVICE_URL);

    const postData = JSON.stringify({
      messageId: messageContent.id,
      timestamp: messageContent.timestamp,
      data: messageContent.data,
    });

    // Prepare headers with baggage propagation
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData).toString(),
    };

    // Manually inject baggage into headers
    // Create a carrier object for header injection
    const carrier: Record<string, string> = {};

    // Get the current context with baggage
    let contextWithBaggage = api.context.active();
    if (currentBaggage) {
      contextWithBaggage = api.propagation.setBaggage(contextWithBaggage, currentBaggage);
    }

    // Inject trace context and baggage into the carrier
    api.propagation.inject(contextWithBaggage, carrier);

    // Merge injected headers with our headers
    Object.assign(headers, carrier);

    const options = {
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname,
      method: 'POST',
      // headers,
    };

    console.log(`   🌐 Calling API service at ${API_SERVICE_URL}/process...`);

    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          console.log(`   ✅ API service response: ${JSON.stringify(response)}`);
          resolve();
        } catch (error) {
          reject(new Error(`Failed to parse API response: ${error}`));
        }
      });
    });

    req.on('error', (error) => {
      console.error(`   ❌ API service call failed: ${error.message}`);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function processMessage(msg: amqpTypes.ConsumeMessage, channel: any): Promise<void> {
  try {
    const messageContent: Message = JSON.parse(msg.content.toString());

    console.log(`\n📥 Received message:`);
    console.log(`   Content: ${JSON.stringify(messageContent)}`);

    // Extract baggage from the current context
    // The auto-instrumentation has already extracted it from the message headers
    const currentBaggage = api.propagation.getBaggage(api.context.active());
    const allBaggage = currentBaggage ? Array.from(currentBaggage.getAllEntries()) : [];

    console.log(`   🎒 Extracted Baggage:`);

    if (allBaggage.length === 0) {
      console.log(`     ⚠️  No baggage found!`);
    } else {
      for (const [key, entry] of allBaggage) {
        console.log(`     - ${key}: ${entry.value}`);
      }
    }

    // Get specific baggage values
    const userId = currentBaggage?.getEntry('user.id');
    const requestSource = currentBaggage?.getEntry('request.source');
    const sessionId = currentBaggage?.getEntry('session.id');

    if (userId) {
      console.log(`   👤 User ID from baggage: ${userId.value}`);
    }
    if (requestSource) {
      console.log(`   🔗 Request source from baggage: ${requestSource.value}`);
    }
    if (sessionId) {
      console.log(`   🔑 Session ID from baggage: ${sessionId.value}`);
    }

    // Get trace context
    const activeSpan = api.trace.getSpan(api.context.active());
    if (activeSpan) {
      const spanContext = activeSpan.spanContext();
      console.log(`   🔍 Trace ID: ${spanContext.traceId}`);
      console.log(`   🔍 Span ID: ${spanContext.spanId}`);
    }

    // Call the API service with the message data
    // We manually propagate baggage by injecting it into HTTP headers
    await callApiService(messageContent, currentBaggage);

    console.log(`   ✅ Message processed successfully`);

    // Acknowledge the message
    channel.ack(msg);

  } catch (error) {
    console.error('Error processing message:', error);

    // Reject the message (requeue it)
    channel.nack(msg, false, true);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\nShutting down consumer...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nShutting down consumer...');
  process.exit(0);
});

// Start consuming
console.log('🚀 Starting AMQP Consumer with OpenTelemetry Baggage Extraction\n');
consumeMessages().catch(console.error);

