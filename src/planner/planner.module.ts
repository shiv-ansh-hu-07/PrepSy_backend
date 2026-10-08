import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlannerController } from './planner.controller';
import { PlannerService } from './planner.service';

@Module({
  imports: [PrismaModule],
  controllers: [PlannerController],
  providers: [PlannerService],
})
export class PlannerModule {}
