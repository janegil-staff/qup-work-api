// /qup-work-api/src/models/User.js
// One account per person. The same user can be a customer, a pro, or both.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { addressSchema, pointSchema } from './schemas/common.js';

const { Schema } = mongoose;

const pushTokenSchema = new Schema(
  {
    token: { type: String, required: true }, // Expo push token
    platform: { type: String, enum: ['ios', 'android', 'web'] },
    locale: String, // the app language, so the push text matches (e.g. 'nb-NO')
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email'],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    phone: { type: String, trim: true },
    avatarUrl: String,

    roles: {
      type: [{ type: String, enum: ['customer', 'pro', 'admin'] }],
      default: ['customer'],
    },
    activeRole: { type: String, enum: ['customer', 'pro'], default: 'customer' }, // app mode switch

    address: addressSchema,
    location: pointSchema,

    emailVerified: { type: Boolean, default: false },
    phoneVerified: { type: Boolean, default: false },
    pushTokens: { type: [pushTokenSchema], default: [] },

    tokenVersion: { type: Number, default: 0, select: false }, // bump = log out all devices
    // Forgot password: a 6-digit code emailed to the user, stored hashed (see auth.controller.js)
    passwordReset: {
      type: new Schema({ codeHash: String, expiresAt: Date, attempts: { type: Number, default: 0 } }, { _id: false }),
      select: false,
    },
    deletedAt: Date,
    status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active' },
    lastLoginAt: Date,
  },
  { timestamps: true }
);

userSchema.index({ location: '2dsphere' });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.virtual('isPro').get(function () {
  return this.roles?.includes('pro') ?? false;
});

userSchema.set('toJSON', {
  virtuals: true,
  transform: (doc, ret) => {
    delete ret.password;
    delete ret.tokenVersion;
    delete ret.passwordReset;
    delete ret.pushTokens;
    delete ret.__v;
    return ret;
  },
});

export const User = mongoose.model('User', userSchema);
