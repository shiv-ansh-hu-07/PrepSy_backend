import express from "express";
import { createRoom, getAllRooms } from "../controllers/roomController.js";
import auth from "../middleware/auth.js";

const router = express.Router();

// CREATE ROOM
router.post("/create", auth, createRoom);

// GET ALL ROOMS
router.get("/", auth, getAllRooms);

export default router;
