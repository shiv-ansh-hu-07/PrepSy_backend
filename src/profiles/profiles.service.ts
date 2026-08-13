import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FriendsService } from '../friends/friends.service';

type ProfileInput = Record<string, unknown>;
type ProfileWriteData = Omit<
  Prisma.UserProfileUncheckedCreateInput,
  'id' | 'userId' | 'createdAt' | 'updatedAt'
>;

type ParsedProfileInput = {
  fullName: string | null;
  age: number | null;
  dailyStudyGoalMinutes: number;
  isDiscoverable: boolean;
  aiMonitorConsent: boolean;
} & Record<(typeof textFields)[number], string | null> &
  Record<(typeof arrayFields)[number], string[]>;

const arrayFields = [
  'goals',
  'interests',
  'skills',
  'languages',
  'examTargets',
  'lookingFor',
  'availability',
] as const;

const textFields = [
  'username',
  'phone',
  'avatarUrl',
  'bio',
  'gender',
  'city',
  'state',
  'country',
  'timezone',
  'institutionType',
  'institutionName',
  'degree',
  'branch',
  'semester',
  'expectedGraduation',
  'company',
  'role',
  'experienceLevel',
  'workMode',
  'collaborationPreference',
  'portfolioUrl',
  'linkedinUrl',
  'githubUrl',
] as const;

const requiredLabels: Record<string, string> = {
  fullName: 'Full name',
  age: 'Age',
  gender: 'Gender',
  goals: 'Goals',
};

const recommendationLabels: Record<string, string> = {
  city: 'City',
  institutionType: 'Institution type',
  institutionName: 'Institution name',
  interests: 'Interests',
  lookingFor: 'Collaboration preference',
  availability: 'Availability',
};

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friends: FriendsService,
  ) {}

  async getMyProfile(userId: string) {
    try {
      const user = await this.getUserWithProfile(userId);
      return { profile: this.serializeProfile(user) };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Could not load your profile. Please try again.');
    }
  }

  async setAvatarUrl(userId: string, avatarUrl: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    try {
      await this.prisma.userProfile.upsert({
        where: { userId },
        create: { userId, avatarUrl },
        update: { avatarUrl },
      });
    } catch (error) {
      if (this.isProfileStorageUnavailable(error)) {
        throw new BadRequestException(
          'Profile storage is still being prepared. Please run the latest database migration and try again.',
        );
      }
      throw new BadRequestException('Could not save your avatar. Please try again.');
    }

    return { avatarUrl };
  }

  async updateMyProfile(userId: string, body: unknown) {
    const input = this.parseInput(body);

    let existingUser: { id: string } | null;
    try {
      existingUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
    } catch {
      throw new BadRequestException('Could not verify your account. Please try again.');
    }

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const validationProfile = {
      fullName: input.fullName,
      age: input.age,
      gender: input.gender,
      goals: input.goals,
    };
    const missingRequiredFields =
      this.getMissingRequiredFields(validationProfile);

    if (missingRequiredFields.length > 0) {
      throw new BadRequestException({
        message: 'Please complete the required profile fields.',
        missingRequiredFields,
      });
    }

    const profileData = this.toProfileUpdateInput(input);

    // Preserve an existing avatar when the incoming payload doesn't carry one.
    const providedAvatarUrl = this.isRecord(body)
      ? this.cleanText((body as Record<string, unknown>).avatarUrl, 220)
      : null;
    if (!providedAvatarUrl) {
      delete (profileData as Record<string, unknown>).avatarUrl;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: userId },
          data: { name: input.fullName },
        });
        await tx.userProfile.upsert({
          where: { userId },
          create: { userId, ...profileData },
          update: profileData,
        });
      });
    } catch (error) {
      if (this.isUniqueProfileValue(error)) {
        throw new BadRequestException('This username is already taken.');
      }

      if (this.isProfileStorageUnavailable(error)) {
        throw new BadRequestException(
          'Profile storage is still being prepared. Please run the latest database migration and try again.',
        );
      }

      throw new BadRequestException('Could not save your profile. Please try again.');
    }

    try {
      const reloadedUser = await this.getUserWithProfile(userId);
      return {
        profile: this.serializeProfile(reloadedUser),
        message: 'Profile saved successfully.',
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new BadRequestException('Profile saved but could not reload. Please refresh the page.');
    }
  }

  private async getUserWithProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    try {
      const profile = await this.prisma.userProfile.findUnique({
        where: { userId },
      });

      return {
        ...user,
        profile,
      };
    } catch (error) {
      if (this.isProfileStorageUnavailable(error)) {
        return {
          ...user,
          profile: null,
        };
      }

      throw error;
    }
  }

  private isProfileStorageUnavailable(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2021', 'P2022'].includes(error.code)
    );
  }

  private isUniqueProfileValue(error: unknown) {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    );
  }

  private parseInput(body: unknown) {
    const input = this.isRecord(body) ? (body as ProfileInput) : {};

    const parsed = {
      fullName: this.cleanText(input.fullName, 90),
      age: this.cleanAge(input.age),
      dailyStudyGoalMinutes: this.cleanGoalMinutes(input.dailyStudyGoalMinutes),
      isDiscoverable:
        typeof input.isDiscoverable === 'boolean' ? input.isDiscoverable : true,
      aiMonitorConsent:
        typeof input.aiMonitorConsent === 'boolean' ? input.aiMonitorConsent : false,
      ...Object.fromEntries(
        textFields.map((field) => [field, this.cleanText(input[field], 220)]),
      ),
      ...Object.fromEntries(
        arrayFields.map((field) => [field, this.cleanArray(input[field])]),
      ),
    } as ParsedProfileInput;

    return parsed;
  }

  private toProfileUpdateInput(input: ParsedProfileInput) {
    const data: ProfileWriteData = {
      username: input.username,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
      bio: input.bio,
      age: input.age,
      gender: input.gender,
      goals: input.goals,
      interests: input.interests,
      skills: input.skills,
      languages: input.languages,
      examTargets: input.examTargets,
      lookingFor: input.lookingFor,
      availability: input.availability,
      city: input.city,
      state: input.state,
      country: input.country,
      timezone: input.timezone,
      institutionType: input.institutionType,
      institutionName: input.institutionName,
      degree: input.degree,
      branch: input.branch,
      semester: input.semester,
      expectedGraduation: input.expectedGraduation,
      company: input.company,
      role: input.role,
      experienceLevel: input.experienceLevel,
      workMode: input.workMode,
      collaborationPreference: input.collaborationPreference,
      dailyStudyGoalMinutes: input.dailyStudyGoalMinutes,
      portfolioUrl: input.portfolioUrl,
      linkedinUrl: input.linkedinUrl,
      githubUrl: input.githubUrl,
      isDiscoverable: input.isDiscoverable,
      aiMonitorConsent: input.aiMonitorConsent,
    };

    return data;
  }

  private serializeProfile(user: {
    id: string;
    email: string;
    name: string | null;
    profile: null | {
      username: string | null;
      phone: string | null;
      avatarUrl: string | null;
      bio: string | null;
      age: number | null;
      gender: string | null;
      goals: string[];
      interests: string[];
      skills: string[];
      languages: string[];
      examTargets: string[];
      lookingFor: string[];
      availability: string[];
      city: string | null;
      state: string | null;
      country: string | null;
      timezone: string | null;
      institutionType: string | null;
      institutionName: string | null;
      degree: string | null;
      branch: string | null;
      semester: string | null;
      expectedGraduation: string | null;
      company: string | null;
      role: string | null;
      experienceLevel: string | null;
      workMode: string | null;
      collaborationPreference: string | null;
      dailyStudyGoalMinutes: number | null;
      portfolioUrl: string | null;
      linkedinUrl: string | null;
      githubUrl: string | null;
      isDiscoverable: boolean;
      aiMonitorConsent: boolean;
      updatedAt: Date;
    };
  }) {
    const profile = user.profile;
    const serialized = {
      userId: user.id,
      email: user.email,
      fullName: user.name || '',
      username: profile?.username || '',
      phone: profile?.phone || '',
      avatarUrl: profile?.avatarUrl || '',
      bio: profile?.bio || '',
      age: profile?.age || null,
      gender: profile?.gender || '',
      goals: profile?.goals || [],
      interests: profile?.interests || [],
      skills: profile?.skills || [],
      languages: profile?.languages || [],
      examTargets: profile?.examTargets || [],
      lookingFor: profile?.lookingFor || [],
      availability: profile?.availability || [],
      city: profile?.city || '',
      state: profile?.state || '',
      country: profile?.country || '',
      timezone: profile?.timezone || '',
      institutionType: profile?.institutionType || '',
      institutionName: profile?.institutionName || '',
      degree: profile?.degree || '',
      branch: profile?.branch || '',
      semester: profile?.semester || '',
      expectedGraduation: profile?.expectedGraduation || '',
      company: profile?.company || '',
      role: profile?.role || '',
      experienceLevel: profile?.experienceLevel || '',
      workMode: profile?.workMode || '',
      collaborationPreference: profile?.collaborationPreference || '',
      dailyStudyGoalMinutes: profile?.dailyStudyGoalMinutes ?? 0,
      portfolioUrl: profile?.portfolioUrl || '',
      linkedinUrl: profile?.linkedinUrl || '',
      githubUrl: profile?.githubUrl || '',
      isDiscoverable: profile?.isDiscoverable ?? true,
      aiMonitorConsent: profile?.aiMonitorConsent ?? false,
      updatedAt: profile?.updatedAt?.toISOString() || null,
    };

    const missingRequiredFields = this.getMissingRequiredFields(serialized);
    const missingRecommendationFields =
      this.getMissingRecommendationFields(serialized);

    return {
      ...serialized,
      completion: {
        requiredComplete: missingRequiredFields.length === 0,
        completionPercent: this.getCompletionPercent(serialized),
        missingRequiredFields,
        missingRecommendationFields,
      },
      matchingSignals: {
        goals: serialized.goals,
        interests: serialized.interests,
        city: serialized.city,
        institutionType: serialized.institutionType,
        institutionName: serialized.institutionName,
        skills: serialized.skills,
        languages: serialized.languages,
        lookingFor: serialized.lookingFor,
        availability: serialized.availability,
      },
    };
  }

  private getMissingRequiredFields(profile: {
    fullName?: string | null;
    age?: number | null;
    gender?: string | null;
    goals?: string[];
  }) {
    const missing: string[] = [];

    if (!profile.fullName?.trim()) missing.push(requiredLabels.fullName);
    if (!profile.age) missing.push(requiredLabels.age);
    if (!profile.gender?.trim()) missing.push(requiredLabels.gender);
    if (!profile.goals?.length) missing.push(requiredLabels.goals);

    return missing;
  }

  private getMissingRecommendationFields(profile: Record<string, unknown>) {
    return Object.entries(recommendationLabels)
      .filter(([field]) => {
        const value = profile[field];
        return Array.isArray(value)
          ? value.length === 0
          : !String(value || '').trim();
      })
      .map(([, label]) => label);
  }

  private getCompletionPercent(profile: Record<string, unknown>) {
    const trackedFields = [
      'fullName',
      'age',
      'gender',
      'goals',
      'interests',
      'city',
      'institutionType',
      'institutionName',
      'lookingFor',
      'availability',
      'skills',
      'languages',
    ];

    const completed = trackedFields.filter((field) => {
      const value = profile[field];
      return Array.isArray(value)
        ? value.length > 0
        : Boolean(String(value || '').trim());
    }).length;

    return Math.round((completed / trackedFields.length) * 100);
  }

  private cleanText(value: unknown, maxLength: number) {
    if (typeof value !== 'string') {
      return null;
    }

    const clean = value.trim().slice(0, maxLength);
    return clean || null;
  }

  private cleanArray(value: unknown) {
    const rawValues = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(',')
        : [];

    return Array.from(
      new Set(
        rawValues
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
          .slice(0, 16),
      ),
    );
  }

  private cleanGoalMinutes(value: unknown) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    if (isNaN(n) || !Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(720, Math.round(n)));
  }

  private cleanAge(value: unknown) {
    if (value === null || value === undefined || value === '' || value === 'null') {
      return null;
    }
    const age = Number(value);
    if (isNaN(age) || !Number.isInteger(age)) {
      return null;
    }
    if (age < 13 || age > 100) {
      throw new BadRequestException('Age must be between 13 and 100.');
    }
    return age;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  // ── Peer recommendation engine ──────────────────────────────────────────────
  // Ranks other discoverable learners on a weighted blend of what they study,
  // interests, language, region, and study style — so a student who "struggles
  // alone" finds the people most worth connecting with. Returns a minimal,
  // privacy-safe card plus category-level reasons (never the person's raw data).
  async discoverPeers(userId: string) {
    const me = await this.prisma.userProfile.findUnique({ where: { userId } });
    const others = await this.prisma.userProfile.findMany({
      where: { isDiscoverable: true, userId: { not: userId } },
      include: { user: { select: { id: true, name: true, lastLoginAt: true } } },
    });

    const norm = (arr?: string[] | null) =>
      (arr || []).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const setOf = (arr?: string[] | null) => new Set(norm(arr));
    const shared = (mine: Set<string>, theirs?: string[] | null) =>
      norm(theirs).filter((t) => mine.has(t));
    // Fraction of *my* items this candidate also has (rewards relevance without
    // penalising people who simply list more things).
    const coverage = (mine: Set<string>, theirs?: string[] | null) =>
      mine.size ? shared(mine, theirs).length / mine.size : 0;
    const eq = (a?: string | null, b?: string | null) =>
      Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

    const myStudy = setOf([...(me?.goals ?? []), ...(me?.examTargets ?? [])]);
    const myInterests = setOf(me?.interests);
    const mySkills = setOf(me?.skills);
    const myLangs = setOf(me?.languages);
    const hasProfileSignals =
      myStudy.size + myInterests.size + mySkills.size + myLangs.size > 0 ||
      Boolean(me?.city || me?.country);

    // Weights sum to 1.0; study intent + language + region dominate, which is
    // what actually makes two learners a good pairing.
    const W = {
      study: 0.3,
      interests: 0.15,
      skills: 0.1,
      language: 0.15,
      region: 0.15,
      collab: 0.05,
      experience: 0.05,
      institution: 0.05,
    };
    const now = Date.now();
    const activityBoost = (last?: Date | null) => {
      if (!last) return 0;
      const days = (now - new Date(last).getTime()) / 86_400_000;
      if (days <= 7) return 0.06;
      if (days <= 30) return 0.03;
      return 0;
    };

    const scored = others.map((p) => {
      const studyScore = coverage(myStudy, [...(p.goals ?? []), ...(p.examTargets ?? [])]);
      const interestScore = coverage(myInterests, p.interests);
      const skillScore = coverage(mySkills, p.skills);
      const sharedLangs = shared(myLangs, p.languages);
      const languageScore =
        myLangs.size && sharedLangs.length ? 0.5 + 0.5 * (sharedLangs.length / myLangs.size) : 0;

      let regionScore = 0;
      if (eq(me?.city, p.city)) regionScore = 1;
      else if (eq(me?.state, p.state)) regionScore = 0.6;
      else if (eq(me?.country, p.country)) regionScore = 0.3;

      const collabScore =
        me?.collaborationPreference && p.collaborationPreference === me.collaborationPreference ? 1 : 0;
      const experienceScore =
        me?.experienceLevel && p.experienceLevel === me.experienceLevel ? 1 : 0;
      const institutionScore = eq(me?.institutionName, p.institutionName) ? 1 : 0;

      const score =
        W.study * studyScore +
        W.interests * interestScore +
        W.skills * skillScore +
        W.language * languageScore +
        W.region * regionScore +
        W.collab * collabScore +
        W.experience * experienceScore +
        W.institution * institutionScore +
        activityBoost(p.user?.lastLoginAt);

      // Privacy-safe reasons: name the dimension that matched, not the value.
      const reasons: string[] = [];
      if (studyScore > 0) reasons.push('Studying similar things');
      if (regionScore >= 1) reasons.push('In your city');
      else if (regionScore >= 0.6) reasons.push('In your state');
      else if (regionScore >= 0.3) reasons.push('In your country');
      if (languageScore > 0) reasons.push('Speaks your language');
      if (institutionScore) reasons.push('Same institution');
      if (reasons.length < 2 && interestScore > 0) reasons.push('Shared interests');
      if (reasons.length < 2 && collabScore) reasons.push('Similar study style');

      return {
        userId: p.userId,
        name: p.user?.name || p.username || 'PrepSy Learner',
        avatarUrl: p.avatarUrl,
        bio: p.bio,
        reasons: reasons.slice(0, 3),
        score,
        recency: p.user?.lastLoginAt ? new Date(p.user.lastLoginAt).getTime() : 0,
      };
    });

    // Drop people already friends (they live in the Friends tab).
    const statusMap = await this.friends.statusMap(userId, scored.map((p) => p.userId));
    const candidates = scored.filter((p) => (statusMap[p.userId] || 'none') !== 'friends');

    const matched = candidates.filter((p) => p.score > 0.02).sort((a, b) => b.score - a.score);
    // Cold start (no profile signals or no matches): show recently-active people.
    const fallback = [...candidates].sort((a, b) => b.recency - a.recency);
    const ranked = matched.length ? matched : fallback;

    const peers = ranked.slice(0, 40).map((p) => ({
      userId: p.userId,
      name: p.name,
      avatarUrl: p.avatarUrl,
      bio: p.bio,
      reasons: p.reasons,
      friendStatus: statusMap[p.userId] || 'none',
    }));

    return { hasProfileSignals, peers };
  }

  // Search all discoverable users by name/username (empty q = browse all).
  // Returns the same minimal card as discovery + friendStatus.
  async searchUsers(userId: string, q: string) {
    const query = (q || '').trim();
    const where: Prisma.UserWhereInput = {
      id: { not: userId },
      profile: { is: { isDiscoverable: true } },
    };
    if (query) {
      where.OR = [
        { name: { contains: query, mode: 'insensitive' } },
        { profile: { is: { username: { contains: query, mode: 'insensitive' } } } },
      ];
    }
    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, name: true, profile: { select: { username: true, avatarUrl: true, bio: true } } },
      take: 40,
      orderBy: { name: 'asc' },
    });
    const statusMap = await this.friends.statusMap(userId, users.map((u) => u.id));
    return users.map((u) => ({
      userId: u.id,
      name: u.name || u.profile?.username || 'PrepSy Learner',
      avatarUrl: u.profile?.avatarUrl ?? null,
      bio: u.profile?.bio ?? null,
      friendStatus: statusMap[u.id] || 'none',
    }));
  }

  // Full profile is only revealed to friends (or self). Otherwise minimal.
  async getPublicProfile(viewerId: string, targetId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, profile: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const p = user.profile;
    const minimal = {
      userId: user.id,
      name: user.name || p?.username || 'PrepSy Learner',
      avatarUrl: p?.avatarUrl ?? null,
      bio: p?.bio ?? null,
    };

    const isSelf = viewerId === targetId;
    const status = isSelf ? 'friends' : await this.friends.statusWith(viewerId, targetId);
    const isFriend = isSelf || status === 'friends';
    if (!isFriend || !p) {
      return { ...minimal, isFriend: false, friendStatus: status };
    }

    return {
      ...minimal,
      isFriend: true,
      friendStatus: 'friends',
      username: p.username,
      role: p.role,
      company: p.company,
      experienceLevel: p.experienceLevel,
      workMode: p.workMode,
      institutionName: p.institutionName,
      institutionType: p.institutionType,
      degree: p.degree,
      branch: p.branch,
      city: p.city,
      country: p.country,
      goals: p.goals,
      interests: p.interests,
      examTargets: p.examTargets,
      skills: p.skills,
      languages: p.languages,
      collaborationPreference: p.collaborationPreference,
      githubUrl: p.githubUrl,
      linkedinUrl: p.linkedinUrl,
      portfolioUrl: p.portfolioUrl,
    };
  }
}
