import { z } from 'zod';
import { passwordHash } from '../store.ts';
import { PostgresAppStore } from './app-store.ts';
import type { PostgresOptions } from './database.ts';

export async function resetPostgresPassword(directory: string, options: PostgresOptions, email: string, password: string) {
  const input = z.object({email:z.string().email().transform(v=>v.toLowerCase()),password:z.string().min(12).max(200)}).parse({email,password});
  const db = await PostgresAppStore.open(directory, options);
  try {
    await db.transaction(async()=>{
      const user=await db.get('SELECT * FROM users WHERE email=?',input.email);
      if(!user)throw new Error('Account not found.');
      await db.run('UPDATE users SET password_hash=? WHERE id=?',passwordHash(input.password),user.id);
      await db.run('DELETE FROM sessions WHERE user_id=?',user.id);
      await db.audit(user.workspace_id,'local administrator','password.reset',user.email);
    });
    return {status:'password_reset',sessions_invalidated:true};
  } finally {await db.close();}
}
