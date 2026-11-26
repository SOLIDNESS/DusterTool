/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/duster.json`.
 */
export type Duster = {
  "address": "5bNbw7Rcx58ybEa6cAZ9W1xa21jXztHhERrqpqM3nXHf",
  "metadata": {
    "name": "duster",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Duster: wymiana martwych tokenow na DUSTER, buyback i staking"
  },
  "instructions": [
    {
      "name": "beginConvert",
      "discriminator": [
        94,
        156,
        112,
        188,
        188,
        162,
        7,
        178
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "instructions",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "buyback",
      "discriminator": [
        106,
        117,
        64,
        30,
        56,
        69,
        7,
        45
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Dowolny portfel; placi oplate sieciowa."
          ],
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "stakeVault",
          "writable": true
        },
        {
          "name": "feeWsol",
          "writable": true
        },
        {
          "name": "treasuryWsol",
          "docs": [
            "Konto wSOL nalezace do portfela treasury."
          ],
          "writable": true
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "position",
          "writable": true
        },
        {
          "name": "positionNftAccount"
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenBVault",
          "writable": true
        },
        {
          "name": "dusterMint"
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "minDusterOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "finishConvert",
      "discriminator": [
        150,
        26,
        204,
        221,
        114,
        245,
        215,
        167
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true,
          "relations": [
            "session"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "session",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  115,
                  115,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "treasury",
          "writable": true
        },
        {
          "name": "swapWsol",
          "docs": [
            "Konto wSOL programu: tedy przychod ze sprzedazy wchodzi do poola.",
            "Uzytkownik nie potrzebuje wlasnego konta wSOL."
          ],
          "writable": true
        },
        {
          "name": "userDuster",
          "docs": [
            "Mozna je pominac, gdy transakcja tylko zamyka konta i nie ma przychodu do zamiany."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "poolAuthority",
          "address": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC"
        },
        {
          "name": "pool",
          "writable": true
        },
        {
          "name": "tokenAVault",
          "writable": true
        },
        {
          "name": "tokenBVault",
          "writable": true
        },
        {
          "name": "dusterMint"
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "eventAuthority"
        },
        {
          "name": "cpAmmProgram",
          "address": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "minRate",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "dusterMint"
              }
            ]
          }
        },
        {
          "name": "dusterMint"
        },
        {
          "name": "wsolMint",
          "address": "So11111111111111111111111111111111111111112"
        },
        {
          "name": "pool"
        },
        {
          "name": "position"
        },
        {
          "name": "stakeVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101,
                  95,
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "feeWsol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  102,
                  101,
                  101,
                  95,
                  119,
                  115,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "swapWsol",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  119,
                  97,
                  112,
                  95,
                  119,
                  115,
                  111,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "initParams"
            }
          }
        }
      ]
    },
    {
      "name": "stake",
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "userStake",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "userDuster",
          "writable": true
        },
        {
          "name": "stakeVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unstake",
      "discriminator": [
        90,
        95,
        107,
        42,
        205,
        124,
        50,
        225
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "userStake",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  116,
                  97,
                  107,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "config"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "userDuster",
          "writable": true
        },
        {
          "name": "stakeVault",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "shares",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateConfig",
      "discriminator": [
        29,
        158,
        252,
        191,
        10,
        83,
        219,
        99
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "config.duster_mint",
                "account": "config"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "updateParams"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "convertSession",
      "discriminator": [
        94,
        87,
        203,
        242,
        118,
        30,
        119,
        103
      ]
    },
    {
      "name": "userStake",
      "discriminator": [
        102,
        53,
        163,
        107,
        9,
        138,
        87,
        153
      ]
    }
  ],
  "events": [
    {
      "name": "buybackExecuted",
      "discriminator": [
        150,
        109,
        157,
        10,
        124,
        24,
        38,
        189
      ]
    },
    {
      "name": "converted",
      "discriminator": [
        48,
        254,
        146,
        135,
        50,
        134,
        136,
        167
      ]
    },
    {
      "name": "staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "unstaked",
      "discriminator": [
        27,
        179,
        156,
        215,
        47,
        71,
        195,
        7
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Program is paused"
    },
    {
      "code": 6001,
      "name": "invalidParameter",
      "msg": "Parameter out of the allowed range"
    },
    {
      "code": 6002,
      "name": "invalidPool",
      "msg": "Pool is not the DUSTER/SOL Meteora DAMM v2 pool"
    },
    {
      "code": 6003,
      "name": "missingFinish",
      "msg": "begin_convert must be followed by finish_convert in the same transaction"
    },
    {
      "code": 6004,
      "name": "invalidTokenAccount",
      "msg": "Account is not a token account owned by the user"
    },
    {
      "code": 6005,
      "name": "duplicateTokenAccount",
      "msg": "The same token account was passed more than once"
    },
    {
      "code": 6006,
      "name": "slippageExceeded",
      "msg": "Received less DUSTER than the minimum accepted amount"
    },
    {
      "code": 6007,
      "name": "buybackTooEarly",
      "msg": "Too early for the next buyback"
    },
    {
      "code": 6008,
      "name": "belowMinimum",
      "msg": "Amount is below the minimum"
    },
    {
      "code": 6009,
      "name": "insufficientShares",
      "msg": "Not enough shares"
    },
    {
      "code": 6010,
      "name": "remainderBelowMinimum",
      "msg": "After a withdrawal the remaining stake must be zero or at least the minimum"
    },
    {
      "code": 6011,
      "name": "mathOverflow",
      "msg": "Math overflow"
    },
    {
      "code": 6012,
      "name": "zeroShares",
      "msg": "Deposit is too small to receive a single share"
    },
    {
      "code": 6013,
      "name": "missingSwapAccounts",
      "msg": "There are sale proceeds to swap but the user's DUSTER account was not provided"
    }
  ],
  "types": [
    {
      "name": "buybackExecuted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "claimedLamports",
            "type": "u64"
          },
          {
            "name": "treasuryLamports",
            "type": "u64"
          },
          {
            "name": "spentLamports",
            "type": "u64"
          },
          {
            "name": "dusterBought",
            "type": "u64"
          },
          {
            "name": "pendingStakerLamports",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Jedyna instancja konfiguracji i stanu dla danego tokena (PDA: \"config\" + mint)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "treasury",
            "docs": [
              "Zwykly portfel, na ktory trafia fee od rentu oraz nasza czesc oplat z poola (jako wSOL)."
            ],
            "type": "pubkey"
          },
          {
            "name": "dusterMint",
            "type": "pubkey"
          },
          {
            "name": "pool",
            "docs": [
              "Pool DUSTER/SOL na Meteora DAMM v2 (token A = DUSTER, token B = wSOL)."
            ],
            "type": "pubkey"
          },
          {
            "name": "position",
            "docs": [
              "Pozycja LP, z ktorej program odbiera oplaty."
            ],
            "type": "pubkey"
          },
          {
            "name": "stakeVault",
            "type": "pubkey"
          },
          {
            "name": "feeWsol",
            "type": "pubkey"
          },
          {
            "name": "rentFeeBps",
            "docs": [
              "Fee od odzyskanego rentu, w punktach bazowych (500 = 5%)."
            ],
            "type": "u16"
          },
          {
            "name": "stakerShareBps",
            "docs": [
              "Czesc oplat z poola przeznaczana na buyback dla stakujacych (5000 = polowa)."
            ],
            "type": "u16"
          },
          {
            "name": "buybackInterval",
            "docs": [
              "Minimalny odstep miedzy buybackami, w sekundach."
            ],
            "type": "i64"
          },
          {
            "name": "releaseDuration",
            "docs": [
              "Czas, przez ktory uwalnia sie nagroda z jednego buybacku, w sekundach."
            ],
            "type": "i64"
          },
          {
            "name": "maxBuybackLamports",
            "docs": [
              "Limit SOL wydawanego w jednym buybacku; reszta czeka na kolejne."
            ],
            "type": "u64"
          },
          {
            "name": "minStake",
            "docs": [
              "Minimalna wplata do stakingu i minimalna pozostawiona kwota."
            ],
            "type": "u64"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "totalAssets",
            "docs": [
              "DUSTER w skarbcu stakingu wedlug ksiegowania programu (z czescia jeszcze nieuwolniona)."
            ],
            "type": "u64"
          },
          {
            "name": "unreleased",
            "docs": [
              "Nieuwolniona nagroda wedlug stanu na `stream_updated`."
            ],
            "type": "u64"
          },
          {
            "name": "streamUpdated",
            "type": "i64"
          },
          {
            "name": "streamEnd",
            "type": "i64"
          },
          {
            "name": "lastBuyback",
            "type": "i64"
          },
          {
            "name": "pendingStakerLamports",
            "docs": [
              "Czesc stakujacych odebrana z poola, ktora czeka na zamiane na DUSTER."
            ],
            "type": "u64"
          },
          {
            "name": "totalConversions",
            "type": "u64"
          },
          {
            "name": "totalAccountsClosed",
            "type": "u64"
          },
          {
            "name": "totalRentLamports",
            "type": "u64"
          },
          {
            "name": "totalRentFeeLamports",
            "type": "u64"
          },
          {
            "name": "totalSaleLamports",
            "type": "u64"
          },
          {
            "name": "totalDusterToUsers",
            "type": "u64"
          },
          {
            "name": "totalFeesClaimedLamports",
            "type": "u64"
          },
          {
            "name": "totalTreasuryLamports",
            "type": "u64"
          },
          {
            "name": "totalBuybackLamports",
            "type": "u64"
          },
          {
            "name": "totalBuybackDuster",
            "type": "u64"
          },
          {
            "name": "swapWsol",
            "docs": [
              "Konto wSOL programu, przez ktore przychod z wymiany wchodzi do poola.",
              "Miedzy transakcjami jest puste: kazda wymiana wplaca i od razu zamienia dokladnie te sama kwote."
            ],
            "type": "pubkey"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "convertSession",
      "docs": [
        "Konto tymczasowe jednej wymiany. Powstaje w `begin_convert` i jest zamykane",
        "w `finish_convert` tej samej transakcji, wiec jego depozyt wraca od razu."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "startLamports",
            "docs": [
              "Saldo SOL uzytkownika na poczatku wymiany."
            ],
            "type": "u64"
          },
          {
            "name": "rentLamports",
            "docs": [
              "Suma depozytow (rentu) na kontach tokenow zgloszonych do zamkniecia."
            ],
            "type": "u64"
          },
          {
            "name": "accounts",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "converted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "accountsClosed",
            "type": "u16"
          },
          {
            "name": "rentLamports",
            "type": "u64"
          },
          {
            "name": "rentFeeLamports",
            "type": "u64"
          },
          {
            "name": "saleLamports",
            "type": "u64"
          },
          {
            "name": "dusterOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "initParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "rentFeeBps",
            "type": "u16"
          },
          {
            "name": "stakerShareBps",
            "type": "u16"
          },
          {
            "name": "buybackInterval",
            "type": "i64"
          },
          {
            "name": "releaseDuration",
            "type": "i64"
          },
          {
            "name": "maxBuybackLamports",
            "type": "u64"
          },
          {
            "name": "minStake",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "staked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "totalAssets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "unstaked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "totalShares",
            "type": "u64"
          },
          {
            "name": "totalAssets",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "updateParams",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "newAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "treasury",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "position",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "rentFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "stakerShareBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "buybackInterval",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "releaseDuration",
            "type": {
              "option": "i64"
            }
          },
          {
            "name": "maxBuybackLamports",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "minStake",
            "type": {
              "option": "u64"
            }
          },
          {
            "name": "paused",
            "type": {
              "option": "bool"
            }
          }
        ]
      }
    },
    {
      "name": "userStake",
      "docs": [
        "Udzialy jednego stakujacego (PDA: \"stake\" + config + portfel)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "shares",
            "type": "u64"
          },
          {
            "name": "deposited",
            "docs": [
              "Suma wplat pomniejszona o wyplaty; sluzy tylko do pokazania zysku w aplikacji."
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
