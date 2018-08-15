import { Client } from 'taskcluster-lib-pulse';
import { slugid } from 'taskcluster-client';
import monitor from 'taskcluster-lib-monitor';
import AsyncIterator from './AsyncIterator';

export default class PulseEngine {
  constructor() {
    this.subscriptions = new Map();
    this.client = new Client({
      username: process.env.PULSE_USERNAME,
      password: process.env.PULSE_PASSWORD,
      hostname: process.env.PULSE_HOSTNAME,
      vhost: process.env.PULSE_VHOST,
      monitor: monitor({
        rootUrl: process.env.TASKCLUSTER_ROOT_URL,
        projectName: 'taskcluster-web-server',
        credentials: {
          clientId: process.env.TASKCLUSTER_CLIENT_ID,
          accessToken: process.env.TASKCLUSTER_ACCESS_TOKEN,
        },
        mock: process.env.NODE_ENV !== 'production',
        enable: process.env.NODE_ENV === 'production',
      }),
    });

    this.connection = new Promise(
      this.client.on.bind(this.client, 'connected')
    );
  }

  async subscribe({ eventName, triggers }, onMessage) {
    const connection = await this.connection;

    try {
      const channel = await connection.amqp.createChannel();
      const queueName = this.client.fullObjectName('queue', slugid());

      await channel.assertQueue(queueName, {
        exclusive: false,
        durable: true,
        autoDelete: true,
      });

      Object.entries(triggers).forEach(([routingKeyPattern, exchanges]) => {
        exchanges.forEach(async exchange => {
          await channel.assertExchange(exchange, 'topic');
          await channel.bindQueue(queueName, exchange, routingKeyPattern);
        });
      });

      const consumer = await channel.consume(queueName, message => {
        onMessage({ [eventName]: message.payload });
      });

      connection.on('retiring', () => {
        // ignore errors in this call: the connection is already retiring..
        channel.cancel(consumer.consumerTag).catch(() => {});
      });
      this.subscriptions.set(queueName, { eventName, onMessage });

      return queueName;
    } catch (err) {
      connection.failed();
      throw err;
    }
  }

  async unsubscribe(subscriptionId) {
    this.subscriptions.delete(subscriptionId);
  }

  asyncIterator(eventName, triggers) {
    return new AsyncIterator(this, { eventName, triggers });
  }
}
