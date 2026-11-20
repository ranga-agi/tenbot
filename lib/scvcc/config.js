/**
 * SCVCC Venue Configuration, URLs & Court Resource Definitions
 */

const groupsConfig = require('../groupsConfig');
const courtsConfig = require('../courtsConfig');

const DEFAULT_SCVCC_HOST = 'https://www.scvcc.com';

function resolveCourtConfigName(venueOrChatId = null) {
  if (!venueOrChatId) {
    return groupsConfig.getCourtConfigName() || 'SCVCC';
  }
  const fromGroup = groupsConfig.getCourtConfigName(venueOrChatId);
  if (fromGroup) return fromGroup;
  return venueOrChatId;
}

function getScvccHost(venueOrChatId = null) {
  const configName = resolveCourtConfigName(venueOrChatId);
  const courtConfig = courtsConfig.getCourtConfig(configName || 'SCVCC', 'scvcc');
  const sysConfig = courtsConfig.getSystemConfig('scvcc');
  return courtConfig?.host || sysConfig?.host || DEFAULT_SCVCC_HOST;
}

function getScvccUrls(venueOrChatId = null) {
  const host = getScvccHost(venueOrChatId);
  return {
    host,
    loginPageUrl: `${host}/member-login`,
    step1Url: `${host}/a_master/net/net_advancedlogin/login.asmx/loginStep1`,
    step2Url: `${host}/a_master/net/net_advancedlogin/login.asmx/loginStep2`,
    bookingPageUrl: `${host}/Default.aspx?p=DynamicModule&pageid=181&tt=booking&ssid=100261&vnf=1`,
    dialogUrl: `${host}/dialog.aspx`
  };
}

// Court Resource Mapping (ResourceType 1 = Tennis / Pickleball Courts)
const COURT_RESOURCE_IDS = {
  'court 1': '1',
  'court 2': '2',
  'court 3': '3',
  'court 4': '4',
  'court 5': '5',
  'court 6': '6',
  'ct 1': '1',
  'ct 2': '2',
  'ct 3': '3',
  'ct 4': '4',
  'ct 5': '5',
  'ct 6': '6',
  'pickleball 1': '16',
  'pickleball 2': '17',
  'pickleball ct 4a': '18',
  'pickleball ct 4b': '19',
  'pb 1': '16',
  'pb 2': '17',
  'pb 4a': '18',
  'pb 4b': '19'
};

const ALL_COURT_DEFINITIONS = [
  { name: 'Court 1', id: '1', sport: 'tennis', type: '1' },
  { name: 'Court 2', id: '2', sport: 'tennis', type: '1' },
  { name: 'Court 3', id: '3', sport: 'tennis', type: '1' },
  { name: 'Court 4', id: '4', sport: 'tennis', type: '1' },
  { name: 'Court 5', id: '5', sport: 'tennis', type: '1' },
  { name: 'Court 6', id: '6', sport: 'tennis', type: '1' },
  { name: 'Pickleball 1', id: '16', sport: 'pickleball', type: '1' },
  { name: 'Pickleball 2', id: '17', sport: 'pickleball', type: '1' },
  { name: 'Pickleball Ct 4A', id: '18', sport: 'pickleball', type: '1' },
  { name: 'Pickleball Ct 4B', id: '19', sport: 'pickleball', type: '1' }
];

module.exports = {
  resolveCourtConfigName,
  getScvccHost,
  getScvccUrls,
  COURT_RESOURCE_IDS,
  ALL_COURT_DEFINITIONS
};
