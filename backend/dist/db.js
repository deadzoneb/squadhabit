"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.prisma = void 0;
const client_1 = require("@prisma/client");
exports.prisma = new client_1.PrismaClient();
exports.db = exports.prisma;
