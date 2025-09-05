import { Injectable, Logger } from '@nestjs/common';
import { Message, Role } from '@prisma/client';
import { MessageContentBlock, MessageContentType } from '@bytebot/shared';

export interface MessageWithCompression extends Message {
  isCompressed?: boolean;
  originalSize?: number;
  userId?: string | null;
}

@Injectable()
export class ContextCompressionService {
  private readonly logger = new Logger(ContextCompressionService.name);
  private readonly MAX_MESSAGES_TO_KEEP = 50;
  private readonly MAX_CONTEXT_SIZE = 150000;

  async compressMessages(
    messages: Message[],
    preserveRecent: number = 10
  ): Promise<MessageWithCompression[]> {
    if (messages.length <= this.MAX_MESSAGES_TO_KEEP) {
      return messages;
    }

    this.logger.log(
      `Compressing ${messages.length} messages to manage context`
    );

    const recentMessages = messages.slice(-preserveRecent);
    const oldMessages = messages.slice(0, -preserveRecent);

    const importantOldMessages = oldMessages.filter(msg => 
      this.isImportantMessage(msg)
    );

    const summary = await this.createSummaryMessage(oldMessages);

    const compressedMessages: MessageWithCompression[] = [
      summary,
      ...importantOldMessages.slice(-5),
      ...recentMessages,
    ];

    this.logger.log(
      `Compressed ${messages.length} messages to ${compressedMessages.length}`
    );

    return compressedMessages;
  }

  private isImportantMessage(message: Message): boolean {
    if (message.role === Role.USER) {
      return true;
    }

    const content = message.content as MessageContentBlock[];
    
    const hasError = content.some(block => {
      if (block.type === MessageContentType.Text) {
        const text = block.text.toLowerCase();
        return text.includes('error') || 
               text.includes('failed') || 
               text.includes('exception');
      }
      return false;
    });

    if (hasError) return true;

    const hasToolUse = content.some(block => 
      block.type === MessageContentType.ToolUse || 
      block.type === MessageContentType.ToolResult
    );

    return hasToolUse;
  }

  private async createSummaryMessage(
    messages: Message[]
  ): Promise<MessageWithCompression> {
    const userMessages = messages.filter(m => m.role === Role.USER);
    const assistantMessages = messages.filter(m => m.role === Role.ASSISTANT);
    
    const summaryText = `[COMPRESSED CONTEXT SUMMARY]
Previous conversation included:
- ${userMessages.length} user messages
- ${assistantMessages.length} assistant responses
- Key actions taken: Various tool uses and responses
- Context has been compressed to manage token limits

Most recent user requests and assistant actions have been preserved.
[END SUMMARY]`;

    return {
      id: 'summary-' + Date.now(),
      createdAt: new Date(),
      updatedAt: new Date(),
      taskId: messages[0]?.taskId || '',
      summaryId: null,
      userId: null,
      role: Role.USER,
      content: [
        {
          type: MessageContentType.Text,
          text: summaryText,
        },
      ] as MessageContentBlock[],
      isCompressed: true,
      originalSize: messages.length,
    };
  }

  estimateMessageSize(message: Message): number {
    const content = message.content as MessageContentBlock[];
    let size = 0;

    for (const block of content) {
      if (block.type === MessageContentType.Text) {
        size += block.text.length;
      } else if (block.type === MessageContentType.ToolUse) {
        size += JSON.stringify(block.input).length;
      } else if (block.type === MessageContentType.ToolResult) {
        const resultContent = typeof block.content === 'string' 
          ? block.content 
          : JSON.stringify(block.content);
        size += resultContent.length;
      }
    }

    return Math.ceil(size / 4);
  }

  shouldCompress(messages: Message[]): boolean {
    if (messages.length > this.MAX_MESSAGES_TO_KEEP) {
      return true;
    }

    let totalSize = 0;
    for (const message of messages) {
      totalSize += this.estimateMessageSize(message);
      if (totalSize > this.MAX_CONTEXT_SIZE) {
        return true;
      }
    }

    return false;
  }
}