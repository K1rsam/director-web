UPDATE "User"
SET "passwordHash" = 'pbkdf2-sha256$100000$TsP4Yto2ucpAltwNiV-Lyg$Q0Nu3rYSDupbNmN_iO2tUoX4UVpPg9Zsg8apQKo4iFc',
    "failedLoginCount" = 0,
    "lockedUntil" = NULL
WHERE "username" = 'tester01';

UPDATE "User"
SET "passwordHash" = 'pbkdf2-sha256$100000$_48kL26qEEGYDjuaC1mohw$EZ7MOVY4Xtrh9tzA6hywds5MsD4QdPwjanaF5syz_zY',
    "failedLoginCount" = 0,
    "lockedUntil" = NULL
WHERE "username" = 'tester02';

UPDATE "User"
SET "passwordHash" = 'pbkdf2-sha256$100000$2_Bp7fukJUlv8PPyNaXRcA$oPkg4GJyOF8Kzb1UIJNvSUVlJmL8pq2HFe-7WrFeCMY',
    "failedLoginCount" = 0,
    "lockedUntil" = NULL
WHERE "username" = 'tester03';

UPDATE "User"
SET "passwordHash" = 'pbkdf2-sha256$100000$3NEXnmVREzKV57EUzsQ8YQ$WH1Jvl_Ml5NoWKlbSOyp3wL-qByygOYJQ-IdpRpHwAg',
    "failedLoginCount" = 0,
    "lockedUntil" = NULL
WHERE "username" = 'tester04';

UPDATE "User"
SET "passwordHash" = 'pbkdf2-sha256$100000$_LxTpJLgqGOHZa5gB8mfTg$B-o076W1C3XcjWRhjmgx7hrIMvbxLWI62v-sM8X105A',
    "failedLoginCount" = 0,
    "lockedUntil" = NULL
WHERE "username" = 'tester05';

DELETE FROM "Session";

