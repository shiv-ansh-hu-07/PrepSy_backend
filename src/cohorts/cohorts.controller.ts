import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { CohortsService } from './cohorts.service';
import { JwtAuthGuard } from '../auth/jwt.guard';
import type { RequestWithUser } from '../auth/auth-user.interface';
import type { CreateCohortInput, UpdateCohortInput, SetPlanInput } from './cohorts.service';

@Controller('cohorts')
@UseGuards(JwtAuthGuard)
export class CohortsController {
  constructor(private cohorts: CohortsService) {}

  private uid(req: RequestWithUser) {
    const id = req?.user?.id || req?.user?.sub;
    if (!id) throw new UnauthorizedException();
    return id as string;
  }

  // ── Cohorts ───────────────────────────────────────────────────────────────

  @Post()
  create(@Req() req: RequestWithUser, @Body() body: CreateCohortInput) {
    return this.cohorts.createCohort(this.uid(req), body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body() body: UpdateCohortInput,
  ) {
    return this.cohorts.updateCohort(id, this.uid(req), body);
  }

  @Get()
  list(@Req() req: RequestWithUser) {
    return this.cohorts.listUserCohorts(this.uid(req));
  }

  // Static route declared before ':id' so it isn't captured as an id.
  @Get('recommended')
  recommended(@Req() req: RequestWithUser) {
    return this.cohorts.recommendedCohorts(this.uid(req));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getCohort(id, this.uid(req));
  }

  @Post(':id/join')
  join(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.joinCohort(id, this.uid(req));
  }

  @Delete(':id/leave')
  leave(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.leaveCohort(id, this.uid(req));
  }

  @Post(':id/plan')
  setPlan(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body() body: SetPlanInput,
  ) {
    return this.cohorts.setPlan(id, this.uid(req), body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.deleteCohort(id, this.uid(req));
  }

  // ── Discussions ───────────────────────────────────────────────────────────

  // ?sessionId=... scopes to a checkpoint thread; omitted = general cohort board.
  @Get(':id/discussions')
  getDiscussions(
    @Param('id') id: string,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.cohorts.getDiscussions(id, sessionId);
  }

  @Post(':id/discussions')
  postDiscussion(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body('content') content: string,
    @Body('parentId') parentId?: string,
    @Body('studySessionId') studySessionId?: string,
  ) {
    return this.cohorts.postDiscussion(id, this.uid(req), content, parentId, studySessionId);
  }

  // ── Study Sessions ────────────────────────────────────────────────────────

  @Get(':id/sessions')
  getSessions(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getSessions(id, this.uid(req));
  }

  // Current-day playback for a cohort room (drives the in-room player).
  @Get('by-room/:roomId/current-session')
  getRoomCurrentSession(@Param('roomId') roomId: string) {
    return this.cohorts.getRoomCurrentSession(roomId);
  }

  @Post(':id/sessions')
  createSession(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body('topic') topic: string,
    @Body('scheduledAt') scheduledAt: string,
  ) {
    return this.cohorts.createSession(id, this.uid(req), topic, new Date(scheduledAt));
  }

  // Mark a missed day as personally caught up (self-study). Body: { done: boolean }.
  @Post(':id/sessions/:sessionId/catchup')
  markCatchup(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Req() req: RequestWithUser,
    @Body('done') done?: boolean,
  ) {
    return this.cohorts.markCatchup(id, this.uid(req), sessionId, done !== false);
  }

  // ── Quizzes ───────────────────────────────────────────────────────────────

  @Post(':id/quiz/generate')
  generateQuiz(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body('numQuestions') numQuestions?: number,
    @Body('sessionId') sessionId?: string,
  ) {
    return this.cohorts.generateQuiz(id, this.uid(req), numQuestions, sessionId);
  }

  @Post(':id/quiz/attempt')
  submitAttempt(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body('questions') questions: unknown[],
    @Body('answers') answers: string[],
    @Body('studySessionId') studySessionId?: string,
  ) {
    return this.cohorts.submitAttempt(id, this.uid(req), questions, answers, studySessionId);
  }

  @Get(':id/quiz/attempts')
  getAttempts(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getAttempts(id, this.uid(req));
  }
}
