import { Injectable, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

const YT_API = 'https://www.googleapis.com/youtube/v3';
const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';

export interface ScheduleDto {
  hoursPerDay: number;
  days: number;
  speed?: number;
  multiplier?: number;
  useLlm?: boolean;
  // Optional: start the schedule from this playlist position (inclusive),
  // so a learner can begin partway through a playlist.
  startPosition?: number;
  // Optional: split videos that overrun the daily budget (beyond the 1h
  // tolerance) into time-based segments spread over consecutive days.
  sliceLongVideos?: boolean;
}

@Injectable()
export class PlaylistsService {
  constructor(private prisma: PrismaService) {}

  extractPlaylistId(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('list');
    } catch {
      // treat raw ID
      if (/^PL[A-Za-z0-9_-]{16,}$/.test(url)) return url;
      return null;
    }
  }

  async analyze(rawUrl: string) {
    const playlistId = this.extractPlaylistId(rawUrl);
    if (!playlistId) {
      throw new BadRequestException('Invalid YouTube playlist URL or ID');
    }

    // Return cached result if fresh (< 7 days)
    const cached = await this.prisma.playlist.findUnique({
      where: { ytPlaylistId: playlistId },
      include: { videos: { orderBy: { position: 'asc' } }, plan: true },
    });

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (cached && cached.cachedAt > sevenDaysAgo && cached.plan) {
      // Refresh the total-hours estimate from real durations (cheap; the cached
      // AI curriculum/roadmap is reused). Fixes older plans that stored a guess.
      try {
        const apiKey = process.env.YOUTUBE_API_KEY;
        if (apiKey && cached.videos?.length) {
          const durations = await this.fetchVideoDurations(
            cached.videos.map((v) => v.ytVideoId),
            apiKey,
          );
          const totalSec = Object.values(durations).reduce((a, b) => a + b, 0);
          const realHours = totalSec > 0 ? Math.round((totalSec / 3600) * 10) / 10 : null;
          if (realHours) {
            const scaled = this.scaleRoadmap(cached.plan.roadmap, realHours);
            await this.prisma.playlistPlan.update({
              where: { playlistId: cached.id },
              data: { estimatedHours: realHours, roadmap: scaled as object },
            });
            cached.plan.estimatedHours = realHours;
            cached.plan.roadmap = scaled;
          }
        }
      } catch {
        /* keep the cached estimate */
      }
      return this.formatResponse(cached);
    }

    // Fetch from YouTube Data API v3
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new InternalServerErrorException('YOUTUBE_API_KEY not configured');

    const [playlistMeta, videos] = await Promise.all([
      this.fetchPlaylistMeta(playlistId, apiKey),
      this.fetchPlaylistVideos(playlistId, apiKey),
    ]);

    // Upsert playlist + videos
    const playlist = await this.prisma.playlist.upsert({
      where: { ytPlaylistId: playlistId },
      create: {
        ytPlaylistId: playlistId,
        title: playlistMeta.title,
        channelTitle: playlistMeta.channelTitle,
        thumbnailUrl: playlistMeta.thumbnailUrl,
        videoCount: videos.length,
        videos: {
          create: videos.map((v) => ({
            ytVideoId: v.ytVideoId,
            title: v.title,
            description: v.description,
            thumbnailUrl: v.thumbnailUrl,
            position: v.position,
          })),
        },
      },
      update: {
        title: playlistMeta.title,
        channelTitle: playlistMeta.channelTitle,
        thumbnailUrl: playlistMeta.thumbnailUrl,
        videoCount: videos.length,
        cachedAt: new Date(),
        videos: {
          deleteMany: {},
          create: videos.map((v) => ({
            ytVideoId: v.ytVideoId,
            title: v.title,
            description: v.description,
            thumbnailUrl: v.thumbnailUrl,
            position: v.position,
          })),
        },
      },
      include: { videos: { orderBy: { position: 'asc' } } },
    });

    // Call AI microservice
    let aiResult: { curriculum: unknown[]; roadmap: unknown[]; difficulty: string; estimatedHours: number };
    try {
      const { data } = await axios.post(`${AI_URL}/analyze`, {
        playlistTitle: playlist.title,
        channelTitle: playlist.channelTitle || '',
        videos: playlist.videos.map((v) => ({
          ytVideoId: v.ytVideoId,
          title: v.title,
          description: v.description || '',
          position: v.position,
        })),
      }, { timeout: 120_000 });
      aiResult = data;
    } catch (err) {
      throw new InternalServerErrorException(`AI analysis failed: ${this.aiErrorMessage(err)}`);
    }

    // The AI's estimatedHours is a guess (it never sees durations) and can be
    // wildly off. Compute the real total length from actual video durations.
    let estimatedHours = aiResult.estimatedHours;
    try {
      const durations = await this.fetchVideoDurations(
        playlist.videos.map((v) => v.ytVideoId),
        apiKey,
      );
      const totalSec = Object.values(durations).reduce((a, b) => a + b, 0);
      if (totalSec > 0) estimatedHours = Math.round((totalSec / 3600) * 10) / 10;
    } catch {
      /* fall back to the AI estimate */
    }

    const scaledRoadmap = this.scaleRoadmap(aiResult.roadmap, estimatedHours);

    // Upsert plan
    const plan = await this.prisma.playlistPlan.upsert({
      where: { playlistId: playlist.id },
      create: {
        playlistId: playlist.id,
        difficulty: aiResult.difficulty,
        estimatedHours,
        curriculum: aiResult.curriculum as object,
        roadmap: scaledRoadmap as object,
      },
      update: {
        difficulty: aiResult.difficulty,
        estimatedHours,
        curriculum: aiResult.curriculum as object,
        roadmap: scaledRoadmap as object,
        generatedAt: new Date(),
      },
    });

    return this.formatResponse({ ...playlist, plan });
  }

  async getById(id: string) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { id },
      include: { videos: { orderBy: { position: 'asc' } }, plan: true },
    });
    if (!playlist) return null;
    return this.formatResponse(playlist);
  }

  // Build a personalized study schedule for a stored playlist. Unlike analyze(),
  // this is per-user (depends on their hours/day + deadline) so it is computed on
  // demand and not cached. Durations aren't stored in the DB, so we fetch them
  // from YouTube here and pass them to the AI /schedule endpoint.
  async schedule(id: string, dto: ScheduleDto) {
    const hoursPerDay = Number(dto.hoursPerDay);
    const days = Number(dto.days);
    if (!hoursPerDay || hoursPerDay <= 0) {
      throw new BadRequestException('hoursPerDay must be a positive number');
    }
    if (!days || days <= 0) {
      throw new BadRequestException('days must be a positive number');
    }

    const playlist = await this.prisma.playlist.findUnique({
      where: { id },
      include: { videos: { orderBy: { position: 'asc' } } },
    });
    if (!playlist) throw new BadRequestException('Playlist not found');
    if (!playlist.videos.length) throw new BadRequestException('Playlist has no videos');

    // Start partway through the playlist if requested — schedule only the
    // videos at or after the chosen position.
    let selectedVideos = playlist.videos;
    if (dto.startPosition != null && Number.isFinite(Number(dto.startPosition))) {
      const startPosition = Number(dto.startPosition);
      selectedVideos = playlist.videos.filter((v) => v.position >= startPosition);
      if (!selectedVideos.length) {
        throw new BadRequestException('No videos at or after the chosen start point');
      }
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new InternalServerErrorException('YOUTUBE_API_KEY not configured');

    const durations = await this.fetchVideoDurations(
      selectedVideos.map((v) => v.ytVideoId),
      apiKey,
    );

    const videos = selectedVideos.map((v) => ({
      ytVideoId: v.ytVideoId,
      title: v.title,
      description: v.description || '',
      position: v.position,
      durationSec: durations[v.ytVideoId] ?? 0,
    }));

    try {
      const { data } = await axios.post(
        `${AI_URL}/schedule`,
        {
          videos,
          hoursPerDay,
          days,
          speed: dto.speed ?? 1.0,
          multiplier: dto.multiplier ?? 1.25,
          useLlm: dto.useLlm ?? true,
        },
        { timeout: 120_000 },
      );

      // Flag videos that overrun the daily budget by more than a 1-hour
      // tolerance window (e.g. a 2h/day plan tolerates up to 3h; a 3.5h video
      // gets flagged so the UI can offer a chapter-based split).
      const budgetMin = hoursPerDay * 60;
      const toleranceMin = budgetMin + 60;
      const longVideos = selectedVideos
        .map((v) => ({
          title: v.title,
          ytVideoId: v.ytVideoId,
          durationMin: Math.round((durations[v.ytVideoId] ?? 0) / 60),
        }))
        .filter((v) => v.durationMin > toleranceMin);

      // If asked, slice each over-long video into consecutive day-sized
      // segments (by time) so it carries forward across days instead of
      // blowing a single day's budget. Over-long videos sit alone on a day
      // (greedy packer), so we split those days in place and renumber.
      if (dto.sliceLongVideos && longVideos.length && Array.isArray(data?.days)) {
        const sliceSec = Math.round(budgetMin * 60);
        const slicedDays: any[] = [];
        for (const day of data.days) {
          const vids = Array.isArray(day.videos) ? day.videos : [];
          const solo = vids.length === 1 ? vids[0] : null;
          if (solo && Number(solo.durationMin) > toleranceMin) {
            const durationSec = Math.round(Number(solo.durationMin) * 60);
            const parts = Math.ceil(durationSec / sliceSec);
            for (let i = 0; i < parts; i++) {
              const startSec = i * sliceSec;
              const endSec = Math.min((i + 1) * sliceSec, durationSec);
              slicedDays.push({
                studyHours: Math.round(((endSec - startSec) / 3600) * 100) / 100,
                videos: [{ ...solo, part: `${i + 1}/${parts}`, startSec, endSec }],
              });
            }
          } else {
            slicedDays.push(day);
          }
        }
        slicedDays.forEach((d, i) => {
          d.day = i + 1;
        });
        data.days = slicedDays;
      }

      return { ...data, longVideos, dailyBudgetMin: budgetMin, sliced: Boolean(dto.sliceLongVideos) };
    } catch (err) {
      throw new InternalServerErrorException(`Schedule generation failed: ${this.aiErrorMessage(err)}`);
    }
  }

  // Surface the AI service's real error. FastAPI returns it as { detail: "..." },
  // so pull that out instead of the generic "Request failed with status code 500".
  private aiErrorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
      const detail = (err.response?.data as { detail?: unknown })?.detail;
      if (typeof detail === 'string' && detail.trim()) return detail;
      return err.message;
    }
    return err instanceof Error ? err.message : 'AI service unavailable';
  }

  private formatResponse(playlist: any) {
    return {
      id: playlist.id,
      ytPlaylistId: playlist.ytPlaylistId,
      title: playlist.title,
      channelTitle: playlist.channelTitle,
      thumbnailUrl: playlist.thumbnailUrl,
      videoCount: playlist.videoCount,
      videos: playlist.videos,
      plan: playlist.plan,
    };
  }

  private async fetchPlaylistMeta(playlistId: string, apiKey: string) {
    const { data } = await axios.get(`${YT_API}/playlists`, {
      params: { id: playlistId, key: apiKey, part: 'snippet,contentDetails' },
    });
    const item = data.items?.[0];
    if (!item) throw new BadRequestException('Playlist not found or is private');
    return {
      title: item.snippet.title as string,
      channelTitle: item.snippet.channelTitle as string,
      thumbnailUrl: (item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null) as string | null,
    };
  }

  private async fetchPlaylistVideos(playlistId: string, apiKey: string): Promise<Array<{ ytVideoId: string; title: string; description: string; thumbnailUrl: string | null; position: number }>> {
    const videos: Array<{ ytVideoId: string; title: string; description: string; thumbnailUrl: string | null; position: number }> = [];
    let pageToken: string | undefined;

    do {
      const { data } = await axios.get(`${YT_API}/playlistItems`, {
        params: {
          playlistId,
          key: apiKey,
          part: 'snippet',
          maxResults: 50,
          ...(pageToken ? { pageToken } : {}),
        },
      });

      for (const item of data.items || []) {
        const snippet = item.snippet;
        if (snippet.resourceId?.kind !== 'youtube#video') continue;
        videos.push({
          ytVideoId: snippet.resourceId.videoId as string,
          title: snippet.title as string,
          description: (snippet.description || '') as string,
          thumbnailUrl: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || null,
          position: (snippet.position as number) + 1,
        });
      }

      pageToken = data.nextPageToken;
    } while (pageToken && videos.length < 200);

    return videos;
  }

  // Fetch real durations (seconds) for a list of video IDs via videos.list
  // contentDetails, 50 IDs per request (the API's batch limit).
  // Scale the AI roadmap's per-week studyHours so they sum to the real total
  // (the AI guesses these without durations, so they're often way off).
  private scaleRoadmap(
    roadmap: Array<{ studyHours?: number }> | unknown,
    targetHours: number,
  ): { studyHours?: number }[] {
    if (!Array.isArray(roadmap) || !targetHours) {
      return (Array.isArray(roadmap) ? roadmap : []) as { studyHours?: number }[];
    }
    const total = roadmap.reduce(
      (s: number, w: { studyHours?: number }) => s + (Number(w?.studyHours) || 0),
      0,
    );
    if (total <= 0) return roadmap as { studyHours?: number }[];
    const scale = targetHours / total;
    return roadmap.map((w: { studyHours?: number }) => ({
      ...w,
      studyHours: Math.max(1, Math.round((Number(w?.studyHours) || 0) * scale)),
    }));
  }

  private async fetchVideoDurations(
    videoIds: string[],
    apiKey: string,
  ): Promise<Record<string, number>> {
    const durations: Record<string, number> = {};
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const { data } = await axios.get(`${YT_API}/videos`, {
        params: { id: batch.join(','), key: apiKey, part: 'contentDetails' },
      });
      for (const item of data.items || []) {
        durations[item.id] = this.parseIso8601Duration(item.contentDetails?.duration);
      }
    }
    return durations;
  }

  // "PT1H30M15S" -> total seconds.
  private parseIso8601Duration(iso: string | undefined): number {
    if (!iso) return 0;
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseInt(m[3] || '0', 10);
    return h * 3600 + min * 60 + s;
  }
}
