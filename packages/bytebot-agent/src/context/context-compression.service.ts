import { Injectable, Logger } from '@nestjs/common';
import { encode } from 'gpt-tokenizer';
import { Anthropic } from '@anthropic-ai/sdk';
import { MessageParam } from '@anthropic-ai/sdk/resources';

export interface CompressionStrategy {
  type: 'summarize' | 'truncate' | 'sliding-window' | 'priority-based';
  maxTokens: number;
  preserveRecent?: number;
  preserveImportant?: boolean;
}

export interface CompressedContext {
  messages: MessageParam[];
  summary?: string;
  compressionRatio: number;
  originalTokenCount: number;
  compressedTokenCount: number;
  strategy: CompressionStrategy;
}

export interface MessagePriority {
  message: MessageParam;
  priority: number;
  tokenCount: number;
  timestamp?: Date;
  isToolUse?: boolean;
  hasError?: boolean;
}

@Injectable()
export class ContextCompressionService {
  private readonly logger = new Logger(ContextCompressionService.name);
  private readonly DEFAULT_MAX_TOKENS = 150000;
  private readonly COMPRESSION_THRESHOLD = 0.75;

  countTokens(messages: MessageParam[]): number {
    let totalTokens = 0;
    
    for (const message of messages) {
      if (typeof message.content === 'string') {
        totalTokens += encode(message.content).length;
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text') {
            totalTokens += encode(block.text).length;
          } else if (block.type === 'tool_use') {
            totalTokens += encode(JSON.stringify(block.input)).length;
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' 
              ? block.content 
              : JSON.stringify(block.content);
            totalTokens += encode(content).length;
          }
        }
      }
    }
    
    return totalTokens;
  }

  async compressContext(
    messages: MessageParam[],
    strategy: CompressionStrategy,
    modelContextWindow: number = this.DEFAULT_MAX_TOKENS
  ): Promise<CompressedContext> {
    const originalTokenCount = this.countTokens(messages);
    const targetTokens = Math.min(strategy.maxTokens, modelContextWindow * this.COMPRESSION_THRESHOLD);
    
    this.logger.log(`Compressing context: ${originalTokenCount} tokens -> target ${targetTokens} tokens`);
    
    if (originalTokenCount <= targetTokens) {
      return {
        messages,
        compressionRatio: 1,
        originalTokenCount,
        compressedTokenCount: originalTokenCount,
        strategy,
      };
    }

    let compressedMessages: MessageParam[];
    let summary: string | undefined;

    switch (strategy.type) {
      case 'summarize':
        const result = await this.summarizeContext(messages, targetTokens);
        compressedMessages = result.messages;
        summary = result.summary;
        break;
      
      case 'truncate':
        compressedMessages = this.truncateContext(messages, targetTokens, strategy.preserveRecent);
        break;
      
      case 'sliding-window':
        compressedMessages = this.slidingWindowCompress(messages, targetTokens);
        break;
      
      case 'priority-based':
        compressedMessages = await this.priorityBasedCompress(messages, targetTokens);
        break;
      
      default:
        compressedMessages = this.truncateContext(messages, targetTokens);
    }

    const compressedTokenCount = this.countTokens(compressedMessages);
    
    return {
      messages: compressedMessages,
      summary,
      compressionRatio: compressedTokenCount / originalTokenCount,
      originalTokenCount,
      compressedTokenCount,
      strategy,
    };
  }

  private async summarizeContext(
    messages: MessageParam[],
    targetTokens: number
  ): Promise<{ messages: MessageParam[]; summary: string }> {
    const preserveCount = Math.floor(messages.length * 0.2);
    const toSummarize = messages.slice(0, -preserveCount);
    const preserved = messages.slice(-preserveCount);
    
    const summary = await this.generateSummary(toSummarize);
    
    const summaryMessage: MessageParam = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[CONTEXT SUMMARY]\n${summary}\n[END SUMMARY]`,
      }],
    };
    
    const compressedMessages = [summaryMessage, ...preserved];
    
    if (this.countTokens(compressedMessages) > targetTokens) {
      return this.summarizeContext(preserved, targetTokens);
    }
    
    return { messages: compressedMessages, summary };
  }

  private truncateContext(
    messages: MessageParam[],
    targetTokens: number,
    preserveRecent: number = 5
  ): MessageParam[] {
    if (messages.length <= preserveRecent) {
      return messages;
    }
    
    const recentMessages = messages.slice(-preserveRecent);
    let currentTokens = this.countTokens(recentMessages);
    
    if (currentTokens > targetTokens) {
      return this.truncateContext(recentMessages, targetTokens, Math.max(1, preserveRecent - 1));
    }
    
    const result = [...recentMessages];
    
    for (let i = messages.length - preserveRecent - 1; i >= 0; i--) {
      const messageTokens = this.countTokens([messages[i]]);
      if (currentTokens + messageTokens <= targetTokens) {
        result.unshift(messages[i]);
        currentTokens += messageTokens;
      } else {
        break;
      }
    }
    
    return result;
  }

  private slidingWindowCompress(
    messages: MessageParam[],
    targetTokens: number
  ): MessageParam[] {
    const windowSize = Math.ceil(messages.length * 0.3);
    const stride = Math.max(1, Math.floor(windowSize * 0.5));
    
    const important = this.identifyImportantMessages(messages);
    const result: MessageParam[] = [];
    
    for (const idx of important) {
      if (this.countTokens([...result, messages[idx]]) <= targetTokens * 0.3) {
        result.push(messages[idx]);
      }
    }
    
    for (let i = messages.length - 1; i >= 0; i -= stride) {
      const window = messages.slice(Math.max(0, i - windowSize), i + 1);
      const representative = this.selectRepresentative(window);
      
      if (representative && !result.includes(representative)) {
        const newResult = [...result, representative].sort((a, b) => 
          messages.indexOf(a) - messages.indexOf(b)
        );
        
        if (this.countTokens(newResult) <= targetTokens) {
          result.push(representative);
        } else {
          break;
        }
      }
    }
    
    return result.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
  }

  private async priorityBasedCompress(
    messages: MessageParam[],
    targetTokens: number
  ): Promise<MessageParam[]> {
    const priorities = this.calculatePriorities(messages);
    
    priorities.sort((a, b) => b.priority - a.priority);
    
    const result: MessageParam[] = [];
    let currentTokens = 0;
    
    for (const item of priorities) {
      if (currentTokens + item.tokenCount <= targetTokens) {
        result.push(item.message);
        currentTokens += item.tokenCount;
      } else if (currentTokens < targetTokens * 0.5) {
        const truncated = await this.truncateMessage(item.message, targetTokens - currentTokens);
        if (truncated) {
          result.push(truncated);
          currentTokens = this.countTokens(result);
        }
      }
    }
    
    return result.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
  }

  private calculatePriorities(messages: MessageParam[]): MessagePriority[] {
    return messages.map((message, index) => {
      let priority = 0;
      
      priority += (index / messages.length) * 30;
      
      if (message.role === 'user') {
        priority += 20;
      }
      
      const hasError = this.messageContainsError(message);
      if (hasError) {
        priority += 25;
      }
      
      const isToolUse = this.messageHasToolUse(message);
      if (isToolUse) {
        priority += 10;
      }
      
      if (index === 0 || index === messages.length - 1) {
        priority += 15;
      }
      
      const tokenCount = this.countTokens([message]);
      if (tokenCount < 100) {
        priority += 5;
      } else if (tokenCount > 1000) {
        priority -= 10;
      }
      
      return {
        message,
        priority,
        tokenCount,
        isToolUse,
        hasError,
      };
    });
  }

  private identifyImportantMessages(messages: MessageParam[]): number[] {
    const important: number[] = [];
    
    messages.forEach((message, index) => {
      if (message.role === 'user') {
        important.push(index);
      }
      
      if (this.messageContainsError(message)) {
        important.push(index);
      }
      
      if (index === 0 || index === messages.length - 1) {
        important.push(index);
      }
    });
    
    return [...new Set(important)];
  }

  private selectRepresentative(window: MessageParam[]): MessageParam | null {
    if (window.length === 0) return null;
    
    const userMessage = window.find(m => m.role === 'user');
    if (userMessage) return userMessage;
    
    const errorMessage = window.find(m => this.messageContainsError(m));
    if (errorMessage) return errorMessage;
    
    const shortestMessage = window.reduce((shortest, current) => {
      const currentTokens = this.countTokens([current]);
      const shortestTokens = this.countTokens([shortest]);
      return currentTokens < shortestTokens ? current : shortest;
    });
    
    return shortestMessage;
  }

  private messageContainsError(message: MessageParam): boolean {
    const content = typeof message.content === 'string' 
      ? message.content 
      : JSON.stringify(message.content);
    
    const errorKeywords = ['error', 'exception', 'failed', 'failure', 'invalid', 'unable'];
    return errorKeywords.some(keyword => content.toLowerCase().includes(keyword));
  }

  private messageHasToolUse(message: MessageParam): boolean {
    if (typeof message.content === 'string') return false;
    
    if (Array.isArray(message.content)) {
      return message.content.some(block => 
        block.type === 'tool_use' || block.type === 'tool_result'
      );
    }
    
    return false;
  }

  private async truncateMessage(
    message: MessageParam,
    maxTokens: number
  ): Promise<MessageParam | null> {
    if (typeof message.content === 'string') {
      const tokens = encode(message.content);
      if (tokens.length <= maxTokens) return message;
      
      const truncatedText = message.content.substring(0, Math.floor(message.content.length * (maxTokens / tokens.length)));
      return {
        ...message,
        content: truncatedText + '... [TRUNCATED]',
      };
    }
    
    if (Array.isArray(message.content)) {
      const truncatedBlocks: typeof message.content = [];
      let currentTokens = 0;
      
      for (const block of message.content) {
        const blockTokens = this.countTokens([{ role: message.role, content: [block] }]);
        
        if (currentTokens + blockTokens <= maxTokens) {
          truncatedBlocks.push(block);
          currentTokens += blockTokens;
        } else if (block.type === 'text' && currentTokens < maxTokens * 0.8) {
          const remainingTokens = maxTokens - currentTokens;
          const truncatedText = block.text.substring(0, Math.floor(block.text.length * (remainingTokens / blockTokens)));
          truncatedBlocks.push({
            ...block,
            text: truncatedText + '... [TRUNCATED]',
          });
          break;
        }
      }
      
      if (truncatedBlocks.length > 0) {
        return {
          ...message,
          content: truncatedBlocks,
        };
      }
    }
    
    return null;
  }

  private async generateSummary(messages: MessageParam[]): Promise<string> {
    const contextText = messages.map(m => {
      if (typeof m.content === 'string') {
        return `${m.role}: ${m.content}`;
      }
      return `${m.role}: ${JSON.stringify(m.content)}`;
    }).join('\n\n');
    
    const summary = `The following conversation has been summarized for context compression:
    
Key Points:
- ${messages.filter(m => m.role === 'user').length} user messages
- ${messages.filter(m => m.role === 'assistant').length} assistant responses
- Main topics discussed: [Analysis of conversation topics would go here]

Summary of conversation:
${contextText.substring(0, 2000)}... [Additional context available if needed]`;
    
    return summary;
  }

  detectContextOverflow(
    currentTokens: number,
    modelContextWindow: number
  ): boolean {
    return currentTokens >= modelContextWindow * this.COMPRESSION_THRESHOLD;
  }

  async adaptiveCompress(
    messages: MessageParam[],
    modelContextWindow: number,
    preferredStrategy?: CompressionStrategy['type']
  ): Promise<CompressedContext> {
    const currentTokens = this.countTokens(messages);
    
    if (!this.detectContextOverflow(currentTokens, modelContextWindow)) {
      return {
        messages,
        compressionRatio: 1,
        originalTokenCount: currentTokens,
        compressedTokenCount: currentTokens,
        strategy: { type: 'truncate', maxTokens: modelContextWindow },
      };
    }
    
    const targetTokens = Math.floor(modelContextWindow * 0.6);
    
    const strategy: CompressionStrategy = {
      type: preferredStrategy || this.selectBestStrategy(messages, currentTokens, modelContextWindow),
      maxTokens: targetTokens,
      preserveRecent: Math.min(10, Math.floor(messages.length * 0.3)),
      preserveImportant: true,
    };
    
    this.logger.warn(
      `Context overflow detected: ${currentTokens}/${modelContextWindow} tokens. ` +
      `Applying ${strategy.type} compression strategy.`
    );
    
    return this.compressContext(messages, strategy, modelContextWindow);
  }

  private selectBestStrategy(
    messages: MessageParam[],
    currentTokens: number,
    modelContextWindow: number
  ): CompressionStrategy['type'] {
    // Always use truncate strategy for simple, fast text-based compression
    // This avoids slow summarization that can cause the agent to hang
    return 'truncate';
  }

  private hasHighPriorityMessages(messages: MessageParam[]): boolean {
    const errorCount = messages.filter(m => this.messageContainsError(m)).length;
    const userMessageCount = messages.filter(m => m.role === 'user').length;
    
    return (errorCount > messages.length * 0.1) || (userMessageCount > messages.length * 0.4);
  }
}