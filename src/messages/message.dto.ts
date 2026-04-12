export interface CreateMessageDto {
  roomId: string;
  text: string;
  senderId?: string;
  senderName?: string;
}
