import * as amqp from 'amqplib';
import * as api from '@opentelemetry/api';

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
const QUEUE_NAME = 'otel-baggage-demo';

interface Message {
  id: number;
  timestamp: string;
  data: string;
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

async function publishMessages(): Promise<void> {
  let connection;
  let channel;

  try {
    // Connect to RabbitMQ with retry logic
    connection = await connectWithRetry();
    channel = await connection.createChannel();

    // Declare the queue
    await channel.assertQueue(QUEUE_NAME, { durable: false });
    console.log(`Queue '${QUEUE_NAME}' is ready`);

    // Publish messages with baggage
    for (let i = 1; i <= 5; i++) {
      await publishMessageWithBaggage(channel, i);
      await sleep(2000); // Wait 2 seconds between messages
    }

    console.log('\nAll messages published successfully!');

    // Close connections
    await channel.close();
    await connection.close();
    console.log('Connection closed');

  } catch (error) {
    console.error('Error in publisher:', error);
    if (channel) await channel.close().catch(() => { });
    if (connection) await connection.close().catch(() => { });
    process.exit(1);
  }
}

async function publishMessageWithBaggage(channel: any, messageNumber: number): Promise<void> {
  try {
    // Create baggage with custom metadata
    const baggageEntries: Record<string, string> = {
      'user.id': `user-${1000 + messageNumber}`,
      'request.source': 'api-gateway',
      'session.id': `session-${Date.now()}`,
      'message.number': messageNumber.toString(),
    };

    // Set baggage in the current context
    let currentBaggage = api.propagation.getBaggage(api.context.active()) || api.propagation.createBaggage();
    for (const [key, value] of Object.entries(baggageEntries)) {
      currentBaggage = currentBaggage.setEntry(key, { value });
    }

    // Store baggage in context
    const ctxWithBaggage = api.propagation.setBaggage(api.context.active(), currentBaggage);

    // Run the publish operation within the baggage context
    await api.context.with(ctxWithBaggage, async () => {
      const message: Message = {
        id: messageNumber,
        timestamp: new Date().toISOString(),
        data: `Message ${messageNumber}`,
      };

      console.log(`\n📤 Publishing message ${messageNumber}:`);
      console.log(`   Content: ${JSON.stringify(message)}`);
      console.log(`   Baggage:`);
      for (const [key, value] of Object.entries(baggageEntries)) {
        console.log(`     - ${key}: ${value}`);
      }

      // Publish the message
      // The auto-instrumentation will automatically inject trace context and baggage
      channel.sendToQueue(QUEUE_NAME, Buffer.from(JSON.stringify(message)));

      console.log(`   ✅ Message ${messageNumber} published with trace and baggage`);
    });

  } catch (error) {
    console.error(`Error publishing message ${messageNumber}:`, error);
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start publishing
console.log('🚀 Starting AMQP Publisher\n');
publishMessages().catch(console.error);

