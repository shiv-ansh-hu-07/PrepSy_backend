import { BadRequestException } from '@nestjs/common';
import { ProfilesService } from './profiles.service';

// uuid ships ESM-only; it is pulled in transitively (friends -> s3) and never
// used by these tests.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

describe('ProfilesService', () => {
  let service: ProfilesService;
  let friends: {
    statusMap: jest.Mock;
    statusWith: jest.Mock;
  };
  let prisma: {
    user: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    userProfile: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      userProfile: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    friends = {
      statusMap: jest.fn(),
      statusWith: jest.fn(),
    };
    service = new ProfilesService(prisma as any, friends as any);
  });

  it('returns missing required fields for an incomplete profile', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'learner@example.com',
      name: '',
    });
    prisma.userProfile.findUnique.mockResolvedValue(null);

    await expect(service.getMyProfile('user-1')).resolves.toMatchObject({
      profile: {
        completion: {
          requiredComplete: false,
          missingRequiredFields: ['Full name', 'Age', 'Gender', 'Goals'],
        },
      },
    });
  });

  it('rejects saving when required fields are missing', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

    await expect(
      service.updateMyProfile('user-1', {
        fullName: 'Shivanshu',
        goals: ['DSA'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('saves complete profile data for matching recommendations', async () => {
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 'user-1' })
      .mockResolvedValueOnce({
        id: 'user-1',
        email: 'learner@example.com',
        name: 'Shivanshu Tiwari',
      });
    prisma.userProfile.findUnique.mockResolvedValue({
      username: 'shivanshu',
      phone: null,
      avatarUrl: null,
      bio: 'Focused learner',
      age: 21,
      gender: 'man',
      goals: ['DSA', 'placements'],
      interests: ['system design'],
      skills: ['Java'],
      languages: ['English'],
      examTargets: [],
      lookingFor: ['project team'],
      availability: ['weekends'],
      city: 'New Delhi',
      state: 'Delhi',
      country: 'India',
      timezone: 'Asia/Kolkata',
      institutionType: 'college',
      institutionName: 'IIT Delhi',
      degree: 'B.Tech',
      branch: 'Computer Science',
      semester: '4th Semester',
      expectedGraduation: 'May 2026',
      company: null,
      role: null,
      experienceLevel: null,
      workMode: null,
      collaborationPreference: 'project-based',
      portfolioUrl: null,
      linkedinUrl: null,
      githubUrl: null,
      isDiscoverable: true,
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
    });
    prisma.user.update.mockResolvedValue({ id: 'user-1' });
    prisma.userProfile.upsert.mockResolvedValue({});
    // The service uses an interactive transaction; run it against the mock.
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => unknown) => run(prisma),
    );

    const result = await service.updateMyProfile('user-1', {
      fullName: 'Shivanshu Tiwari',
      username: 'shivanshu',
      bio: 'Focused learner',
      age: 21,
      gender: 'man',
      goals: ['DSA', 'placements'],
      interests: ['system design'],
      city: 'New Delhi',
      institutionType: 'college',
      institutionName: 'IIT Delhi',
      lookingFor: ['project team'],
      availability: ['weekends'],
    });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { name: 'Shivanshu Tiwari' },
    });
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
        create: expect.objectContaining({
          userId: 'user-1',
          goals: ['DSA', 'placements'],
          city: 'New Delhi',
          institutionType: 'college',
        }),
      }),
    );
    expect(result.profile.completion.requiredComplete).toBe(true);
    expect(result.profile.matchingSignals).toMatchObject({
      city: 'New Delhi',
      institutionType: 'college',
      institutionName: 'IIT Delhi',
      goals: ['DSA', 'placements'],
    });
  });
});
