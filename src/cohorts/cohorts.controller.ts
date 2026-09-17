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

  // "Meet your crew" — members with their intro/goal + prep-for.
  @Get(':id/crew')
  getCrew(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getCrew(id, this.uid(req));
  }

  // Set my intro (goal + short blurb) for this cohort.
  @Post(':id/intro')
  setIntro(
    @Param('id') id: string,
    @Req() req: RequestWithUser,
    @Body('goal') goal?: string,
    @Body('blurb') blurb?: string,
  ) {
    return this.cohorts.setCohortIntro(id, this.uid(req), goal, blurb);
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

  // Recompute the remaining schedule from watched progress (creator only).
  // Also runs automatically when the cohort watches ahead.
  @Post(':id/recompute-schedule')
  recomputeSchedule(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.recomputeScheduleManual(id, this.uid(req));
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

  // Per-member, per-day notes (revisitable).
  @Get(':id/sessions/:sessionId/notes')
  getNote(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.cohorts.getSessionNote(id, this.uid(req), sessionId);
  }

  @Post(':id/sessions/:sessionId/notes')
  setNote(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Req() req: RequestWithUser,
    @Body('text') text: string,
  ) {
    return this.cohorts.setSessionNote(id, this.uid(req), sessionId, text);
  }

  // AI opening question that seeds a day's checkpoint discussion thread.
  @Get(':id/sessions/:sessionId/discussion-prompt')
  getDiscussionPrompt(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.cohorts.getDiscussionPrompt(id, this.uid(req), sessionId);
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

  @Get(':id/progress')
  getProgress(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getProgress(id, this.uid(req));
  }

  // Current-day playback for a cohort room (drives the in-room player).
  @Get('by-room/:roomId/current-session')
  getRoomCurrentSession(@Param('roomId') roomId: string) {
    return this.cohorts.getRoomCurrentSession(roomId);
  }

  // Full playlist + the caller's watched set, for the in-room Playlist browser.
  @Get('by-room/:roomId/playlist')
  getRoomPlaylist(@Param('roomId') roomId: string, @Req() req: RequestWithUser) {
    return this.cohorts.getRoomPlaylist(roomId, this.uid(req));
  }

  // Record that the caller finished a video in this cohort room (per-member
  // progress). No-ops for non-cohort rooms / non-members.
  @Post('by-room/:roomId/video-complete')
  markVideoWatched(
    @Param('roomId') roomId: string,
    @Req() req: RequestWithUser,
    @Body('videoId') videoId: string,
  ) {
    return this.cohorts.markVideoWatched(roomId, this.uid(req), videoId);
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

  // ── Topic checkpoints (hard-gated) ──────────────────────────────────────────

  // The caller's topic progression: per-topic videos, watched/complete state,
  // whether the checkpoint is passed, and whether the topic is unlocked.
  @Get(':id/topics')
  getTopics(@Param('id') id: string, @Req() req: RequestWithUser) {
    return this.cohorts.getTopics(id, this.uid(req));
  }

  // Generate a checkpoint quiz for one topic (refused while the topic is locked).
  @Post(':id/topics/:index/quiz')
  generateTopicQuiz(
    @Param('id') id: string,
    @Param('index') index: string,
    @Req() req: RequestWithUser,
    @Body('numQuestions') numQuestions?: number,
  ) {
    return this.cohorts.generateTopicQuiz(id, this.uid(req), Number(index), numQuestions);
  }

  // Submit a topic checkpoint attempt (passing unlocks the next topic).
  @Post(':id/topics/:index/attempt')
  submitTopicAttempt(
    @Param('id') id: string,
    @Param('index') index: string,
    @Req() req: RequestWithUser,
    @Body('questions') questions: unknown[],
    @Body('answers') answers: string[],
  ) {
    return this.cohorts.submitTopicAttempt(id, this.uid(req), Number(index), questions, answers);
  }
}
