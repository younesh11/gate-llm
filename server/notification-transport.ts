import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { z } from 'zod';

export type DeliveryMessage = { channel: 'email' | 'sns'; to?: string; title: string; body: string };
export type NotificationTransport = { email: boolean; sns: boolean; send(message: DeliveryMessage, signal: AbortSignal): Promise<string>; close?(): void };
export function awsNotificationTransport(env: NodeJS.ProcessEnv = process.env): NotificationTransport {
  const from = env.NOTIFICATION_EMAIL_FROM, topic = env.NOTIFICATION_SNS_TOPIC_ARN;
  const region = env.NOTIFICATION_AWS_REGION ?? env.AWS_REGION;
  if ((from || topic) && (!region || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))) throw new Error('Notifications require NOTIFICATION_AWS_REGION.');
  if (from) z.string().email().max(150).parse(from);
  if (topic && !new RegExp(`^arn:aws:sns:${region}:\\d{12}:[a-zA-Z0-9_-]+$`).test(topic)) throw new Error('Use a standard SNS topic in the notification region.');
  const config = { region, maxAttempts: 1, ignoreConfiguredEndpointUrls: true, requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 } };
  const ses = from ? new SESv2Client(config) : undefined, sns = topic ? new SNSClient(config) : undefined;
  return { email: !!ses, sns: !!sns,
    async send(message, signal) {
      if (message.channel === 'email' && ses && message.to) {
        const result = await ses.send(new SendEmailCommand({ FromEmailAddress: from, Destination: { ToAddresses: [message.to] }, Content: { Simple: { Subject: { Data: message.title, Charset: 'UTF-8' }, Body: { Text: { Data: message.body, Charset: 'UTF-8' } } } } }), { abortSignal: signal });
        if (!result.MessageId) throw new Error('Missing delivery acknowledgement');
        return result.MessageId;
      }
      if (message.channel === 'sns' && sns) {
        const result = await sns.send(new PublishCommand({ TopicArn: topic, Subject: message.title.replace(/[\r\n]/g, ' ').slice(0,100), Message: message.body }), { abortSignal: signal });
        if (!result.MessageId) throw new Error('Missing delivery acknowledgement');
        return result.MessageId;
      }
      throw new Error('Delivery channel unavailable');
    },
    close() { ses?.destroy(); sns?.destroy(); }
  };
}
