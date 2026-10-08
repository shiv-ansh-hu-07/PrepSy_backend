import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import { PlannerService } from './planner.service';

@Controller('planner')
@UseGuards(JwtAuthGuard)
export class PlannerController {
  constructor(private readonly planner: PlannerService) {}

  private uid(req: RequestWithUser) {
    const id = req?.user?.id || req?.user?.sub;
    if (!id) throw new UnauthorizedException();
    return id;
  }

  // One interview turn. LLM-backed: tighter limit protects the Groq quota.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('chat')
  chat(@Req() req: RequestWithUser, @Body('messages') messages: unknown) {
    return this.planner.chat(this.uid(req), messages);
  }

  // Generate + save a plan from the collected answers (one big LLM call).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('plans')
  create(
    @Req() req: RequestWithUser,
    @Body('profile') profile: unknown,
    @Body('messages') messages: unknown,
  ) {
    return this.planner.createPlan(this.uid(req), profile, messages);
  }

  @Get('plans')
  list(@Req() req: RequestWithUser) {
    return this.planner.listPlans(this.uid(req));
  }

  @Get('plans/:id')
  get(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.planner.getPlan(this.uid(req), id);
  }

  @Patch('plans/:id/progress')
  progress(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body('topicId') topicId: string,
    @Body('done') done: boolean,
  ) {
    return this.planner.setTopicDone(this.uid(req), id, topicId, done === true);
  }

  @Delete('plans/:id')
  remove(@Req() req: RequestWithUser, @Param('id') id: string) {
    return this.planner.deletePlan(this.uid(req), id);
  }
}
