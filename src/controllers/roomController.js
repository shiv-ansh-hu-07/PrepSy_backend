import { v4 as uuidv4 } from "uuid";

export const createRoom = async (req, res) => {
  try {
    const { name, roomId } = req.body;

    // fallback if frontend didn't generate
    const finalRoomId = roomId || uuidv4();

    // In real app, save room to DB here  
    // For now, send response
    return res.json({
      success: true,
      roomId: finalRoomId,
      name: name || "Untitled Room",
    });

  } catch (err) {
    console.error("Room create error:", err);
    return res.status(500).json({ message: "Failed to create room" });
  }
};

export const getAllRooms = async (req, res) => {
  // optional for your dashboard join UI
  res.json({
    rooms: [
      { roomId: "abc123", name: "Maths Room" },
      { roomId: "xyz789", name: "Physics Study" }
    ]
  });
};
