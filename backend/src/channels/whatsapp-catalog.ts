// Generated verbatim from whatsapp/templates.json. Keep in sync with that source.
export const catalog = {
  "footer": {
    "ro": "Simulare – Craiova Hackathon 2026",
    "en": "Simulation – Craiova Hackathon 2026"
  },
  "templates": [
    {
      "name": "abonare_confirmata",
      "category": "utility",
      "trigger": "abonare nouă (QR, boarding pass sau număr de zbor)",
      "audience": "toți abonații",
      "languages": {
        "ro": {
          "header": "Alerte activate",
          "body": "Ați activat alertele pentru Aeroportul Craiova, ca {{rol}}.\n\nVă scriem doar când se schimbă ceva care vă afectează: zboruri suspendate, redirecționări, evacuarea terminalului sau reluarea operațiunilor. Puteți opri alertele oricând cu butonul de mai jos.",
          "buttons": [
            "Opresc alertele"
          ],
          "examples": {
            "rol": "pasager pe zborul W4 3831 din 31 octombrie"
          }
        },
        "en": {
          "header": "Alerts turned on",
          "body": "You have turned on alerts for Craiova Airport as {{rol}}.\n\nWe only message you when something changes that affects you: suspended flights, diversions, a terminal evacuation or the restart of operations. You can stop the alerts at any time with the button below.",
          "buttons": [
            "Stop alerts"
          ],
          "examples": {
            "rol": "a passenger on flight W4 3831 on 31 October"
          }
        }
      }
    },
    {
      "name": "suspendare_pasager",
      "category": "utility",
      "trigger": "ops.suspended",
      "audience": "pasageri cu plecare",
      "languages": {
        "ro": {
          "header": "Zboruri suspendate temporar",
          "body": "Decolările și aterizările pe Aeroportul Craiova sunt suspendate temporar de la ora {{ora}}. Motiv: {{motiv}}.\n\nZborul *{{zbor}}* spre {{destinatie}} nu este anulat deocamdată. Terminalul rămâne deschis. Vă rugăm să veniți la ora obișnuită, nu mai devreme. Până la ora {{ora_update}} vă trimitem ora estimată de plecare.\n\nUnde vă aflați acum?",
          "buttons": [
            "Sunt în terminal",
            "Sunt pe drum",
            "Nu am plecat încă"
          ],
          "examples": {
            "ora": "13:52",
            "motiv": "dronă neautorizată semnalată lângă pistă",
            "zbor": "W4 3831",
            "destinatie": "Bruxelles Charleroi",
            "ora_update": "14:30"
          }
        },
        "en": {
          "header": "Flights temporarily suspended",
          "body": "Take-offs and landings at Craiova Airport have been suspended since {{ora}}. Reason: {{motiv}}.\n\nFlight *{{zbor}}* to {{destinatie}} is not cancelled at this time. The terminal remains open. Please come at your usual time, not earlier. By {{ora_update}} we will send you the estimated departure time.\n\nWhere are you right now?",
          "buttons": [
            "I am in the terminal",
            "I am on my way",
            "I have not left yet"
          ],
          "examples": {
            "ora": "13:52",
            "motiv": "unauthorised drone reported near the runway",
            "zbor": "W4 3831",
            "destinatie": "Brussels Charleroi",
            "ora_update": "14:30"
          }
        }
      }
    },
    {
      "name": "suspendare_asteptare",
      "category": "utility",
      "trigger": "ops.suspended",
      "audience": "cei care așteaptă o sosire",
      "languages": {
        "ro": {
          "header": "Sosiri afectate",
          "body": "Aterizările pe Aeroportul Craiova sunt suspendate temporar de la ora {{ora}}. Motiv: {{motiv}}.\n\nZborul *{{zbor}}* din {{origine}}, pe care îl așteptați, poate întârzia sau poate fi redirecționat către alt aeroport. Dacă nu ați plecat încă, nu porniți acum spre aeroport. Vă anunțăm imediat ce știm unde și când aterizează.\n\nUnde vă aflați acum?",
          "buttons": [
            "Sunt la aeroport",
            "Sunt pe drum",
            "Nu am plecat încă"
          ],
          "examples": {
            "ora": "12:58",
            "motiv": "dronă neautorizată semnalată lângă pistă",
            "zbor": "W4 3752",
            "origine": "Londra Luton"
          }
        },
        "en": {
          "header": "Arrivals affected",
          "body": "Landings at Craiova Airport have been suspended since {{ora}}. Reason: {{motiv}}.\n\nFlight *{{zbor}}* from {{origine}}, which you are waiting for, may be delayed or diverted to another airport. If you have not left yet, please do not set off for the airport now. We will tell you as soon as we know where and when it lands.\n\nWhere are you right now?",
          "buttons": [
            "I am at the airport",
            "I am on my way",
            "I have not left yet"
          ],
          "examples": {
            "ora": "12:58",
            "motiv": "unauthorised drone reported near the runway",
            "zbor": "W4 3752",
            "origine": "London Luton"
          }
        }
      }
    },
    {
      "name": "suspendare_taxi",
      "category": "utility",
      "trigger": "ops.suspended",
      "audience": "taxi și ride-hailing",
      "languages": {
        "ro": {
          "header": "Sosiri oprite temporar",
          "body": "Aterizările pe Aeroportul Craiova sunt suspendate de la ora {{ora}}. Nu se așteaptă nicio sosire cel puțin până la ora {{ora_minima}}.\n\nDacă așteptați la rândul de taxi de la T2, puteți pleca. Vă anunțăm din timp, înainte de prima aterizare. Vă rugăm să lăsați liberă banda din fața terminalului pentru vehiculele de urgență.",
          "buttons": [
            "Plec acum",
            "Rămân la T2"
          ],
          "examples": {
            "ora": "13:52",
            "ora_minima": "14:40"
          }
        }
      }
    },
    {
      "name": "suspendare_personal",
      "category": "utility",
      "trigger": "ops.suspended",
      "audience": "personalul și companiile din aeroport",
      "languages": {
        "ro": {
          "header": "Operațiuni suspendate",
          "body": "Decolările și aterizările pe Aeroportul Craiova sunt suspendate de la ora {{ora}}. Motiv: {{motiv}}.\n\nInstrucțiuni pentru echipa dumneavoastră: {{instructiuni}}\n\nVă rugăm să confirmați primirea acestui mesaj.",
          "buttons": [
            "Am primit"
          ],
          "examples": {
            "ora": "13:52",
            "motiv": "dronă neautorizată semnalată lângă pistă",
            "instructiuni": "echipele de handling rămân în zona de așteptare, iar vehiculele de pe platformă se retrag în parcarea dedicată."
          }
        }
      }
    },
    {
      "name": "zbor_redirectionat",
      "category": "utility",
      "trigger": "flight.diverted",
      "audience": "cei care așteaptă zborul",
      "languages": {
        "ro": {
          "header": "Zbor redirecționat",
          "body": "Zborul *{{zbor}}* din {{origine}} a fost redirecționat și va ateriza la {{aeroport}}, estimat la ora {{ora}}.\n\nNu mai este nevoie să veniți la Aeroportul Craiova pentru acest zbor. Compania aeriană le comunică pasagerilor cum continuă călătoria. Vă scriem dacă avionul revine la Craiova.",
          "buttons": [
            "Am înțeles"
          ],
          "examples": {
            "zbor": "W4 3752",
            "origine": "Londra Luton",
            "aeroport": "Timișoara (TSR)",
            "ora": "13:35"
          }
        },
        "en": {
          "header": "Flight diverted",
          "body": "Flight *{{zbor}}* from {{origine}} has been diverted and will land at {{aeroport}}, estimated at {{ora}}.\n\nThere is no need to come to Craiova Airport for this flight. The airline will tell passengers how their journey continues. We will message you if the aircraft returns to Craiova.",
          "buttons": [
            "Understood"
          ],
          "examples": {
            "zbor": "W4 3752",
            "origine": "London Luton",
            "aeroport": "Timișoara (TSR)",
            "ora": "13:35"
          }
        }
      }
    },
    {
      "name": "evacuare_terminal",
      "category": "utility",
      "trigger": "decizia de evacuare din consolă (după payload.suspicious)",
      "audience": "toți abonații",
      "languages": {
        "ro": {
          "header": "Evacuare terminal T2",
          "body": "Terminalul T2 al Aeroportului Craiova se evacuează preventiv de la ora {{ora}}. Nu veniți la aeroport.\n\nDacă sunteți pe drum, nu intrați pe rampele de acces spre T2 și lăsați drumul liber pentru ISU și SMURD. Dacă sunteți în terminal, urmați indicațiile personalului. Vă anunțăm când terminalul se redeschide.",
          "buttons": [
            "Am ieșit din clădire",
            "Sunt încă în terminal",
            "Nu sunt la aeroport"
          ],
          "examples": {
            "ora": "14:20"
          }
        },
        "en": {
          "header": "Terminal T2 evacuation",
          "body": "As a precaution, Terminal T2 at Craiova Airport has been under evacuation since {{ora}}. Do not come to the airport.\n\nIf you are on your way, do not take the access ramps to T2 and keep the road clear for fire and ambulance crews. If you are in the terminal, follow the instructions of airport staff. We will tell you when the terminal reopens.",
          "buttons": [
            "I am out of the building",
            "I am still inside",
            "I am not at the airport"
          ],
          "examples": {
            "ora": "14:20"
          }
        }
      }
    },
    {
      "name": "reluare_pasager",
      "category": "utility",
      "trigger": "ops.reopened",
      "audience": "pasageri cu plecare",
      "languages": {
        "ro": {
          "header": "Zborurile se reiau",
          "body": "Decolările și aterizările pe Aeroportul Craiova s-au reluat la ora {{ora}}.\n\nZborul *{{zbor}}* spre {{destinatie}} are ora estimată de plecare {{ora_plecare}}. Ca să evităm aglomerația la intrare, vă rugăm să ajungeți la terminal în intervalul {{interval}}. Urmăriți și mesajele companiei aeriene.",
          "buttons": [
            "Am înțeles"
          ],
          "examples": {
            "ora": "14:40",
            "zbor": "W4 3831",
            "destinatie": "Bruxelles Charleroi",
            "ora_plecare": "15:25",
            "interval": "14:45–15:05"
          }
        },
        "en": {
          "header": "Flights are resuming",
          "body": "Take-offs and landings at Craiova Airport resumed at {{ora}}.\n\nFlight *{{zbor}}* to {{destinatie}} is now expected to depart at {{ora_plecare}}. To avoid crowding at the entrance, please arrive at the terminal between {{interval}}. Please also follow your airline's messages.",
          "buttons": [
            "Understood"
          ],
          "examples": {
            "ora": "14:40",
            "zbor": "W4 3831",
            "destinatie": "Brussels Charleroi",
            "ora_plecare": "15:25",
            "interval": "14:45 and 15:05"
          }
        }
      }
    },
    {
      "name": "reluare_asteptare",
      "category": "utility",
      "trigger": "ops.reopened",
      "audience": "cei care așteaptă o sosire",
      "languages": {
        "ro": {
          "header": "Aterizare estimată",
          "body": "Operațiunile pe Aeroportul Craiova s-au reluat. Zborul *{{zbor}}* din {{origine}} este estimat să aterizeze la ora {{ora_aterizare}}.\n\nVă rugăm să ajungeți după ora {{ora_sosire}}, ca să nu aglomerăm zona de sosiri și parcarea. Vă scriem dacă ora se schimbă.",
          "buttons": [
            "Am înțeles"
          ],
          "examples": {
            "zbor": "W4 3752",
            "origine": "Londra Luton",
            "ora_aterizare": "14:55",
            "ora_sosire": "14:45"
          }
        },
        "en": {
          "header": "Estimated landing",
          "body": "Operations at Craiova Airport have resumed. Flight *{{zbor}}* from {{origine}} is expected to land at {{ora_aterizare}}.\n\nPlease arrive after {{ora_sosire}} so that the arrivals area and the car park do not get crowded. We will message you if the time changes.",
          "buttons": [
            "Understood"
          ],
          "examples": {
            "zbor": "W4 3752",
            "origine": "London Luton",
            "ora_aterizare": "14:55",
            "ora_sosire": "14:45"
          }
        }
      }
    },
    {
      "name": "reluare_taxi",
      "category": "utility",
      "trigger": "ops.reopened",
      "audience": "taxi și ride-hailing",
      "languages": {
        "ro": {
          "header": "Sosirile se reiau",
          "body": "Aterizările pe Aeroportul Craiova se reiau. Primul avion este estimat să aterizeze la ora {{ora_aterizare}}. Pasageri estimați: {{pasageri}}.\n\nPuteți reveni la rândul de taxi de la T2 începând cu ora {{ora_acces}}. Vă rugăm să nu veniți mai devreme, ca accesul să rămână liber pentru vehiculele aeroportului.",
          "buttons": [
            "Vin la T2",
            "Nu vin"
          ],
          "examples": {
            "ora_aterizare": "14:55",
            "pasageri": "218",
            "ora_acces": "14:35"
          }
        }
      }
    }
  ]
} as const;
