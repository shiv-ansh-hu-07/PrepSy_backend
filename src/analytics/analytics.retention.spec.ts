// Founder cohort-retention view: weekly buckets from the per-day study log.
import { AnalyticsService } from './analytics.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('getCohortRetention', () => {
  beforeAll(() => {
    // Wednesday 2026-10-14 IST → this week starts Monday 2026-10-12.
    jest.useFakeTimers().setSystemTime(new Date('2026-10-14T10:00:00+05:30'));
  });
  afterAll(() => jest.useRealTimers());

  it('buckets days into IST weeks, ignores <5 min days, counts 3+ day members', async () => {
    const prisma: any = {
      cohortStudyDay: {
        findMany: jest.fn().mockResolvedValue([
          // last week: Ann 3 active days, Bo 1 day + a 2-minute peek
          { cohortId: 'c1', userId: 'a', day: '2026-10-05', seconds: 3600 },
          { cohortId: 'c1', userId: 'a', day: '2026-10-06', seconds: 1800 },
          { cohortId: 'c1', userId: 'a', day: '2026-10-11', seconds: 600 },
          { cohortId: 'c1', userId: 'b', day: '2026-10-07', seconds: 1200 },
          { cohortId: 'c1', userId: 'b', day: '2026-10-08', seconds: 120 },
          // this week: only Ann so far
          { cohortId: 'c1', userId: 'a', day: '2026-10-13', seconds: 2400 },
        ]),
      },
      cohort: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'c1', name: 'DSA', syncMode: 'SYNC', visibility: 'PUBLIC', createdAt: new Date(),
            members: [
              { userId: 'a', joinedAt: new Date(), user: { name: 'Ann', email: 'a@x' } },
              { userId: 'b', joinedAt: new Date(), user: { name: 'Bo', email: 'b@x' } },
              { userId: 'c', joinedAt: new Date(), user: { name: 'Cy', email: 'c@x' } },
            ],
          },
        ]),
      },
    };
    const res: any = await new AnalyticsService(prisma).getCohortRetention(2);
    expect(res.weekStarts).toEqual(['2026-10-05', '2026-10-12']);
    const [lastWeek, thisWeek] = res.cohorts[0].perWeek;
    expect(lastWeek).toMatchObject({ activeMembers: 2, threePlusDays: 1, minutes: 122 });
    expect(thisWeek).toMatchObject({ activeMembers: 1, partial: true, minutes: 40 });
    const ann = res.cohorts[0].members.find((m: any) => m.userId === 'a');
    expect(ann.daily.find((d: any) => d.day === '2026-10-13').minutes).toBe(40);
    expect(ann.lastActiveDay).toBe('2026-10-13');
    const bo = res.cohorts[0].members.find((m: any) => m.userId === 'b');
    expect(bo.perWeek[0].days).toBe(1); // the 2-minute peek isn't an active day
  });
});
