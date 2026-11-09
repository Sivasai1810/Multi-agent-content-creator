import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { validateEnv } from './config/env.validation';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    // isGlobal: every module can use ConfigService.
    // validate: the app stops at startup if the settings are wrong.
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], validate: validateEnv }),
    QueueModule,
  ],
})
export class AppModule {}
