import { Test, TestingModule } from '@nestjs/testing';
import { ContextCompressionService, CompressionStrategy } from './context-compression.service';
import { MessageParam } from '@anthropic-ai/sdk/resources';

describe('ContextCompressionService', () => {
  let service: ContextCompressionService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContextCompressionService],
    }).compile();

    service = module.get<ContextCompressionService>(ContextCompressionService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('countTokens', () => {
    it('should count tokens for string content', () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Hello world' },
        { role: 'assistant', content: 'Hi there' },
      ];
      
      const count = service.countTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should count tokens for structured content blocks', () => {
      const messages: MessageParam[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'text', text: 'World' },
          ],
        },
      ];
      
      const count = service.countTokens(messages);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle tool use blocks', () => {
      const messages: MessageParam[] = [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'test',
              name: 'calculator',
              input: { operation: 'add', a: 1, b: 2 },
            },
          ],
        },
      ];
      
      const count = service.countTokens(messages);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('compressContext', () => {
    const createMessages = (count: number): MessageParam[] => {
      return Array.from({ length: count }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: This is a test message with some content to make it meaningful`,
      })) as MessageParam[];
    };

    it('should not compress if under token limit', async () => {
      const messages = createMessages(5);
      const strategy: CompressionStrategy = {
        type: 'truncate',
        maxTokens: 10000,
      };

      const result = await service.compressContext(messages, strategy);
      
      expect(result.compressionRatio).toBe(1);
      expect(result.messages.length).toBe(messages.length);
    });

    it('should truncate messages when over limit', async () => {
      const messages = createMessages(50);
      const strategy: CompressionStrategy = {
        type: 'truncate',
        maxTokens: 100,
        preserveRecent: 5,
      };

      const result = await service.compressContext(messages, strategy);
      
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.messages.length).toBeLessThanOrEqual(messages.length);
      expect(result.compressedTokenCount).toBeLessThanOrEqual(strategy.maxTokens);
    });

    it('should apply sliding window compression', async () => {
      const messages = createMessages(30);
      const strategy: CompressionStrategy = {
        type: 'sliding-window',
        maxTokens: 200,
      };

      const result = await service.compressContext(messages, strategy);
      
      expect(result.compressionRatio).toBeLessThan(1);
      expect(result.messages.length).toBeLessThan(messages.length);
    });

    it('should prioritize important messages', async () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Important user message' },
        { role: 'assistant', content: 'Regular response' },
        { role: 'assistant', content: 'Error: Something failed' },
        { role: 'user', content: 'Another user message' },
        { role: 'assistant', content: 'Final response' },
      ];

      const strategy: CompressionStrategy = {
        type: 'priority-based',
        maxTokens: 50,
      };

      const result = await service.compressContext(messages, strategy);
      
      const resultContent = result.messages.map(m => 
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      ).join(' ');
      
      expect(resultContent).toContain('user');
      expect(result.messages.some(m => {
        const content = typeof m.content === 'string' 
          ? m.content 
          : JSON.stringify(m.content);
        return content.toLowerCase().includes('error');
      })).toBeTruthy();
    });

    it('should create summary when summarizing', async () => {
      const messages = createMessages(20);
      const strategy: CompressionStrategy = {
        type: 'summarize',
        maxTokens: 100,
      };

      const result = await service.compressContext(messages, strategy);
      
      expect(result.summary).toBeDefined();
      expect(result.messages[0].content).toBeDefined();
      
      const firstMessageContent = result.messages[0].content;
      if (Array.isArray(firstMessageContent)) {
        expect(firstMessageContent[0].type).toBe('text');
        if (firstMessageContent[0].type === 'text') {
          expect(firstMessageContent[0].text).toContain('CONTEXT SUMMARY');
        }
      }
    });
  });

  describe('detectContextOverflow', () => {
    it('should detect overflow at 75% threshold', () => {
      const modelWindow = 1000;
      
      expect(service.detectContextOverflow(500, modelWindow)).toBe(false);
      expect(service.detectContextOverflow(750, modelWindow)).toBe(true);
      expect(service.detectContextOverflow(900, modelWindow)).toBe(true);
    });
  });

  describe('adaptiveCompress', () => {
    it('should select appropriate strategy based on compression ratio', async () => {
      const smallMessages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      })) as MessageParam[];

      const result = await service.adaptiveCompress(smallMessages, 50);
      expect(result.strategy.type).toBe('truncate');

      const largeMessages = Array.from({ length: 100 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `This is a very long message ${i} with lots of content that will definitely overflow the context window and require summarization`,
      })) as MessageParam[];

      const largeResult = await service.adaptiveCompress(largeMessages, 100);
      expect(largeResult.strategy.type).toBe('summarize');
    });

    it('should not compress if under threshold', async () => {
      const messages: MessageParam[] = [
        { role: 'user', content: 'Short message' },
      ];

      const result = await service.adaptiveCompress(messages, 10000);
      
      expect(result.compressionRatio).toBe(1);
      expect(result.messages).toEqual(messages);
    });

    it('should handle different model context windows', async () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        role: 'assistant',
        content: `Message ${i} with moderate content`,
      })) as MessageParam[];

      const smallWindow = await service.adaptiveCompress(messages, 100);
      const largeWindow = await service.adaptiveCompress(messages, 200000);

      expect(smallWindow.compressedTokenCount).toBeLessThan(
        largeWindow.compressedTokenCount
      );
    });
  });
});