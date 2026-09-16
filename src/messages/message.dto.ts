export interface CreateMessageDto {
  roomId: string;
  text: string;
  senderId?: string;
  senderName?: string;
  replyToText?: string;
  replyToSender?: string;
}
