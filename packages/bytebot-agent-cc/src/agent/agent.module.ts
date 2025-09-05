import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { MessagesModule } from '../messages/messages.module';
import { AgentProcessor } from './agent.processor';
import { ConfigModule } from '@nestjs/config';
import { AgentScheduler } from './agent.scheduler';
import { InputCaptureService } from './input-capture.service';
import { AgentAnalyticsService } from './agent.analytics';
import { ContextModule } from '../context/context.module';

@Module({
  imports: [ConfigModule, TasksModule, MessagesModule, ContextModule],
  providers: [
    AgentProcessor,
    AgentScheduler,
    InputCaptureService,
    AgentAnalyticsService,
  ],
  exports: [AgentProcessor],
})
export class AgentModule {}
