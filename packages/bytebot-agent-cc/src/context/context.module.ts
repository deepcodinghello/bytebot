import { Module } from '@nestjs/common';
import { ContextCompressionService } from './context-compression.service';

@Module({
  providers: [ContextCompressionService],
  exports: [ContextCompressionService],
})
export class ContextModule {}