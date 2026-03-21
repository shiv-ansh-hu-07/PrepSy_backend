import { Test, TestingModule } from '@nestjs/testing';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

describe('RoomsController', () => {
  let controller: RoomsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RoomsController],
      providers: [
        {
          provide: RoomsService,
          useValue: {
            createRoom: jest.fn(),
            getRooms: jest.fn(),
            getPublicRooms: jest.fn(),
            getMyRooms: jest.fn(),
            joinRoom: jest.fn(),
            searchRoomsByTags: jest.fn(),
            deleteRoom: jest.fn(),
            getRoomMessages: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<RoomsController>(RoomsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
