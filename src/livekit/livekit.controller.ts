import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AccessToken } from "livekit-server-sdk";

@Controller("livekit")
export class LivekitController {
  @Get("token")
  async getToken(
    @Query("room") room: string,
    @Query("user") user: string,
    @Query("name") name: string,   // ✅ NEW: display name
    @Res() res: Response
  ) {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      console.error("❌ Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET");
      return res.status(500).json({ error: "LiveKit keys missing" });
    }

    if (!room) {
      console.error("❌ LiveKit token requested with undefined room");
      return res.status(400).json({ error: "Room is required" });
    }

    // ✅ SAFETY FALLBACKS
    const identity = user || `guest-${Math.random().toString(36).slice(2)}`;
    const displayName = name || "Guest";

    // ✅ CREATE TOKEN WITH NAME
    const at = new AccessToken(apiKey, apiSecret, {
      identity,              // technical unique ID
      name: displayName,     // 👈 what UI shows
      ttl: "2h",
    });

    // ✅ REQUIRED GRANTS
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const jwt = await at.toJwt();

    console.log("✅ LiveKit token generated");
    console.log("Room:", room);
    console.log("Identity:", identity);
    console.log("Display Name:", displayName);

    return res.json({
      token: jwt,
    });
  }
}
