-- Bootstrap the existing test accounts on a new empty Site. Existing users are never changed.
INSERT OR IGNORE INTO "User" ("id","email","username","passwordHash","name","createdAt","updatedAt") VALUES ('studio-tester01','tester01@local.invalid','tester01','pbkdf2-sha256$100000$TsP4Yto2ucpAltwNiV-Lyg$Q0Nu3rYSDupbNmN_iO2tUoX4UVpPg9Zsg8apQKo4iFc','测试账号 01',1788591599466,1788591599466);
--> statement-breakpoint
INSERT OR IGNORE INTO "User" ("id","email","username","passwordHash","name","createdAt","updatedAt") VALUES ('studio-tester02','tester02@local.invalid','tester02','pbkdf2-sha256$100000$_48kL26qEEGYDjuaC1mohw$EZ7MOVY4Xtrh9tzA6hywds5MsD4QdPwjanaF5syz_zY','测试账号 02',1788591599466,1788591599466);
--> statement-breakpoint
INSERT OR IGNORE INTO "User" ("id","email","username","passwordHash","name","createdAt","updatedAt") VALUES ('studio-tester03','tester03@local.invalid','tester03','pbkdf2-sha256$100000$2_Bp7fukJUlv8PPyNaXRcA$oPkg4GJyOF8Kzb1UIJNvSUVlJmL8pq2HFe-7WrFeCMY','测试账号 03',1788591599466,1788591599466);
--> statement-breakpoint
INSERT OR IGNORE INTO "User" ("id","email","username","passwordHash","name","createdAt","updatedAt") VALUES ('studio-tester04','tester04@local.invalid','tester04','pbkdf2-sha256$100000$3NEXnmVREzKV57EUzsQ8YQ$WH1Jvl_Ml5NoWKlbSOyp3wL-qByygOYJQ-IdpRpHwAg','测试账号 04',1788591599466,1788591599466);
--> statement-breakpoint
INSERT OR IGNORE INTO "User" ("id","email","username","passwordHash","name","createdAt","updatedAt") VALUES ('studio-tester05','tester05@local.invalid','tester05','pbkdf2-sha256$100000$_LxTpJLgqGOHZa5gB8mfTg$B-o076W1C3XcjWRhjmgx7hrIMvbxLWI62v-sM8X105A','测试账号 05',1788591599466,1788591599466);
