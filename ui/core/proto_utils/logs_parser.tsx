import clsx from 'clsx';

import { CacheHandler } from '../cache_handler';
import { RaidSimResult } from '../proto/api.js';
import { SpellSchool } from '../proto/common';
import { ResourceType, SecondaryResourceType } from '../proto/spell';
import { bucket, getEnumValues, stringComparator, sum } from '../utils.js';
import { ActionId } from './action_id.js';
import { resourceNames, spellSchoolNames, stringToResourceType } from './names.js';
import { SECONDARY_RESOURCES } from './secondary_resource';

export class Entity {
	readonly name: string;
	readonly ownerName: string; // Blank if not a pet.

	// Either target index, player index, or owner index depending on what kind
	// of entity this is.
	readonly index: number;

	readonly isTarget: boolean;
	readonly isPet: boolean;

	constructor(name: string, ownerName: string, index: number, isTarget: boolean, isPet: boolean) {
		this.name = name;
		this.ownerName = ownerName;
		this.index = index;
		this.isTarget = isTarget;
		this.isPet = isPet;
	}

	equals(other: Entity) {
		return this.isTarget == other.isTarget && this.isPet == other.isPet && this.index == other.index && this.name == other.name;
	}

	toString(): string {
		if (this.isTarget) {
			return `Target ${this.index + 1}`;
		} else if (this.isPet) {
			return `${this.ownerName} (#${this.index + 1}) - ${this.name}`;
		} else {
			return `${this.name} (#${this.index + 1})`;
		}
	}

	toHTML() {
		if (this.isTarget) {
			return <span className="text-danger">[Target {this.index + 1}]</span>;
		} else if (this.isPet) {
			return (
				<>
					<span className="text-primary">{`[${this.ownerName} ${this.index + 1}]`}</span>
					{` - `}
					{this.name}
				</>
			);
		} else {
			return <span className="text-primary">{`[${this.name} ${this.index + 1}]`}</span>;
		}
	}

	// Parses one or more Entities from a string.
	// Each entity label should be one of:
	//   'Target 1' if a target,
	//   'PlayerName (#1)' if a player, or
	//   'PlayerName (#1) - PetName' if a pet.
	static parseRegex = /\[(Target (\d+))|(([a-zA-Z0-9]+) \(#(\d+)\) - ([a-zA-Z0-9\s:,]+))|(([a-zA-Z0-9\s]+) \(#(\d+)\))\]/g;
	static parseAll(str: string): Array<Entity> {
		return Array.from(str.matchAll(Entity.parseRegex)).map(match => {
			if (match[1]) {
				return new Entity(match[1], '', parseInt(match[2]) - 1, true, false);
			} else if (match[3]) {
				return new Entity(match[6], match[4], parseInt(match[5]) - 1, false, true);
			} else if (match[7]) {
				return new Entity(match[8], '', parseInt(match[9]) - 1, false, false);
			} else {
				throw new Error('Invalid Entity match');
			}
		});
	}
}

interface SimLogParams {
	raw: string;
	logIndex: number;
	timestamp: number;
	source: Entity | null;
	target: Entity | null;
	actionId: ActionId | null;
	spellSchool: SpellSchool | null;
	threat: number;
}

const cachedActionIdLink = new CacheHandler<HTMLAnchorElement>();

export class SimLog {
	readonly raw: string;

	// Index of this log within the full log output.
	// When comparing timestamps this should be used instead of timestamp, because
	// timestamp is scraped from log text and doesn't have enough precision.
	readonly logIndex: number;

	// Time in seconds from the encounter start.
	readonly timestamp: number;

	readonly source: Entity | null;
	readonly target: Entity | null;
	readonly actionId: ActionId | null;
	readonly actionIdAsString: string | null = null;

	// Spell schoool from this event. Note that not all events have spell schools, so this will be 0null.
	readonly spellSchool: SpellSchool | null;
	// Amount of threat generated from this event. Note that not all events generate threat, so this will be 0.
	readonly threat: number;

	// Logs for auras that were active at this timestamp.
	// This is only filled if populateActiveAuras() is called.
	activeAuras: Array<AuraUptimeLog>;

	cachedHTML: Record<string | number, Element | null> = {};

	constructor(params: SimLogParams) {
		this.raw = params.raw;
		this.logIndex = params.logIndex;
		this.timestamp = params.timestamp;
		this.source = params.source;
		this.target = params.target;
		this.actionId = params.actionId;
		try {
			this.actionIdAsString = this.actionId?.toString() || null;
		} catch {}
		this.spellSchool = params.spellSchool;
		this.threat = params.threat;
		this.activeAuras = [];
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => {
			let html = <>{this.raw}</>;
			// Base logs already have the timestamp appended by default
			if (!includeTimestamp) {
				const regexp = /(\[[0-9.-]+\]) (\[[0-9a-zA-Z\s\-()#]+\])?(.*)/;
				if (this.raw.match(regexp)) {
					// TypeScript doesn't handle regex capture typing well
					const captureArr = regexp.exec(this.raw);

					if (captureArr && captureArr.length == 4) {
						html = <>{captureArr[3]}</>;
					}
				}
			}

			if (this.source) {
				html = (
					<>
						{this.source.toHTML()} {html}
					</>
				);
			}
			return html;
		});
	}

	toPrefix(includeTimestamp = true) {
		let prefix = '';
		if (includeTimestamp) {
			prefix = `[${this.timestamp.toFixed(2)}]`;
		}

		return (
			<>
				{prefix}
				{this.source?.toHTML()}
			</>
		);
	}

	formattedTimestamp(): string {
		const positiveTimestamp = Math.abs(this.timestamp);
		const minutes = Math.floor(positiveTimestamp / 60);
		const seconds = Math.floor(positiveTimestamp - minutes * 60);
		const milliseconds = ((positiveTimestamp - Math.floor(positiveTimestamp)) * 1000).toFixed();

		let formatted = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(milliseconds).padStart(3, '0')}`;
		if (this.timestamp < 0) {
			formatted = `-${formatted}`;
		}
		return formatted;
	}

	protected newActionIdLink(isAura?: boolean) {
		const cacheKey = this.actionIdAsString ? `${this.actionIdAsString}${isAura || ''}` : undefined;
		const cachedLink = cacheKey ? cachedActionIdLink.get(cacheKey) : null;
		if (cachedLink) return cachedLink.cloneNode(true);

		const iconElem = (<span className="icon icon-sm"></span>) as HTMLSpanElement;
		const actionAnchor = (
			<a className="log-action" target="_blank">
				<span>
					{iconElem} {this.actionId!.name}
				</span>
			</a>
		) as HTMLAnchorElement;
		this.actionId?.setBackground(iconElem);
		this.actionId?.setWowheadHref(actionAnchor);
		this.actionId?.setWowheadDataset(actionAnchor, { useBuffAura: isAura });
		if (cacheKey) cachedActionIdLink.set(cacheKey, actionAnchor.cloneNode(true) as HTMLAnchorElement);
		return actionAnchor;
	}

	static async parseAll(result: RaidSimResult): Promise<SimLog[]> {
		const lines = result.logs.split('\n');
		return Promise.all(
			lines.map((line, lineIndex) => {
				const params: SimLogParams = {
					raw: line,
					logIndex: lineIndex,
					timestamp: 0,
					source: null,
					target: null,
					actionId: null,
					spellSchool: null,
					threat: 0,
				};
				const spellSchoolMatch = line.match(/ \(SpellSchool: (-?[0-9]+)\)/);
				if (spellSchoolMatch) {
					params.spellSchool = parseInt(spellSchoolMatch[1]);
				}

				const threatMatch = line.match(/ \(Threat: (-?[0-9]+\.[0-9]+)\)/);
				if (threatMatch) {
					params.threat = parseFloat(threatMatch[1]);
					line = line.substring(0, threatMatch.index);
				}

				const match = line.match(/\[(-?[0-9]+\.[0-9]+)\]\w*(.*)/);
				if (!match || !match[1]) {
					return new SimLog(params);
				}

				params.timestamp = parseFloat(match[1]);
				const remainder = match[2];

				const entities = Entity.parseAll(remainder);
				params.source = entities[0] || null;
				params.target = entities[1] || null;

				// Order from most to least common to reduce number of checks.
				return (
					DamageDealtLog.parse(params) ||
					ResourceChangedLog.parse(params) ||
					AuraEventLog.parse(params) ||
					AuraStacksChangeLog.parse(params) ||
					MajorCooldownUsedLog.parse(params) ||
					CastBeganLog.parse(params) ||
					CastCompletedLog.parse(params) ||
					StatChangeLog.parse(params) ||
					Promise.resolve(new SimLog(params))
				);
			}),
		);
	}

	isDamageDealt(): this is DamageDealtLog {
		return this instanceof DamageDealtLog;
	}

	isResourceChanged(): this is ResourceChangedLog {
		return this instanceof ResourceChangedLog;
	}

	isAuraEvent(): this is AuraEventLog {
		return this instanceof AuraEventLog;
	}

	isAuraStacksChange(): this is AuraStacksChangeLog {
		return this instanceof AuraStacksChangeLog;
	}

	isMajorCooldownUsed(): this is MajorCooldownUsedLog {
		return this instanceof MajorCooldownUsedLog;
	}

	isCastBegan(): this is CastBeganLog {
		return this instanceof CastBeganLog;
	}

	isCastCompleted(): this is CastCompletedLog {
		return this instanceof CastCompletedLog;
	}

	isStatChange(): this is StatChangeLog {
		return this instanceof StatChangeLog;
	}

	// Group events that happen at the same time.
	static groupDuplicateTimestamps<LogType extends SimLog>(logs: Array<LogType>): Array<Array<LogType>> {
		const grouped: Array<Array<LogType>> = [];
		let curGroup: Array<LogType> = [];

		logs.forEach(log => {
			if (curGroup.length == 0 || log.timestamp == curGroup[0].timestamp) {
				curGroup.push(log);
			} else {
				grouped.push(curGroup);
				curGroup = [log];
			}
		});
		if (curGroup.length > 0) {
			grouped.push(curGroup);
		}

		return grouped;
	}

	cacheOutput(cacheKey: string | number | boolean, fn: () => Element) {
		if (this.cachedHTML[String(cacheKey)]) return this.cachedHTML[String(cacheKey)] as Element;
		this.cachedHTML[String(cacheKey)] = fn();
		return this.cachedHTML[String(cacheKey)]! as Element;
	}
}

export class DamageDealtLog extends SimLog {
	readonly amount: number;
	readonly type: string;
	readonly miss: boolean;
	readonly hit: boolean;
	readonly crit: boolean;
	readonly crush: boolean;
	readonly glance: boolean;
	readonly dodge: boolean;
	readonly parry: boolean;
	readonly block: boolean;
	readonly tick: boolean;
	readonly partialResist1_4: boolean;
	readonly partialResist2_4: boolean;
	readonly partialResist3_4: boolean;

	constructor(
		params: SimLogParams,
		amount: number,
		type: string,
		miss: boolean,
		crit: boolean,
		crush: boolean,
		glance: boolean,
		dodge: boolean,
		parry: boolean,
		block: boolean,
		tick: boolean,
		partialResist1_4: boolean,
		partialResist2_4: boolean,
		partialResist3_4: boolean,
	) {
		super(params);
		this.amount = amount;
		this.type = type;
		this.miss = miss;
		this.glance = glance;
		this.dodge = dodge;
		this.parry = parry;
		this.block = block;
		this.hit = !miss && !crit;
		this.crit = crit;
		this.crush = crush;
		this.tick = tick;
		this.partialResist1_4 = partialResist1_4;
		this.partialResist2_4 = partialResist2_4;
		this.partialResist3_4 = partialResist3_4;
	}

	isDamage(): boolean {
		return this.type == 'damage';
	}

	isHealing(): boolean {
		return this.type == 'healing';
	}

	isShielding(): boolean {
		return this.type == 'shielding';
	}

	result() {
		const spellSchoolString = typeof this.spellSchool === 'number' ? spellSchoolNames.get(this.spellSchool) : undefined;
		return (
			<>
				{this.isHealing() ? `Healed ` : ''}
				{this.isShielding() ? `Shielded ` : ''}
				{!(this.isHealing() || this.isShielding()) && (
					<>
						{this.miss
							? 'Miss'
							: this.dodge
							? 'Dodge'
							: this.parry
							? 'Parry'
							: this.block
							? this.crit
								? 'Critical Block'
								: this.glance
								? 'Blocked Glance'
								: 'Block'
							: this.glance
							? 'Glance'
							: this.crit
							? 'Crit'
							: this.crush
							? 'Crush'
							: this.tick
							? 'Tick'
							: 'Hit'}
					</>
				)}
				{` `}
				{this.target?.toHTML() || ''}
				{!this.miss && !this.dodge && !this.parry ? (
					<>
						{' '}
						for{' '}
						{this.isHealing() || this.isShielding() ? (
							<strong className={clsx('resource-health')}>{this.amount.toFixed(2)} health</strong>
						) : (
							<strong className={clsx('text-danger', spellSchoolString && `spell-school-${spellSchoolString.toLowerCase()}`)}>
								{this.amount.toFixed(2)} damage
								{spellSchoolString && <> ({spellSchoolString})</>}
							</strong>
						)}
						{this.partialResist1_4 ? (
							<> (10% Resist)</>
						) : this.partialResist2_4 ? (
							<> (20% Resist)</>
						) : this.partialResist3_4 ? (
							<> (30% Resist)</>
						) : (
							''
						)}
						.
					</>
				) : (
					''
				)}
			</>
		);
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => {
			const threatPostfix = this.source?.isTarget ? '' : ` (${this.threat.toFixed(2)} Threat)`;
			return (
				<>
					{this.toPrefix(includeTimestamp)} {this.newActionIdLink()} {this.result()}
					{threatPostfix}
				</>
			);
		});
	}

	static parse(params: SimLogParams): Promise<DamageDealtLog> | null {
		const match = params.raw.match(
			/] (.*?) (tick )?((Miss)|(Hit)|(CriticalBlock)|(Crit)|(Crush)|(GlanceBlock)|(Glance)|(Dodge)|(Parry)|(Block))( \((\d+)% Resist\))?( for (\d+\.\d+) ((damage)|(healing)|(shielding)))?/,
		);
		if (match) {
			return ActionId.fromLogString(match[1])
				.fill(params.source?.index)
				.then(cause => {
					params.actionId = cause;

					const amount = match[17] ? parseFloat(match[17]) : 0;
					const type = match[18] || '';

					return new DamageDealtLog(
						params,
						amount,
						type,
						match[3] == 'Miss',
						match[3] == 'Crit' || match[3] == 'CriticalBlock',
						match[3] == 'Crush',
						match[3] == 'Glance' || match[3] == 'GlanceBlock',
						match[3] == 'Dodge',
						match[3] == 'Parry',
						match[3] == 'Block' || match[3] == 'CriticalBlock' || match[3] == 'GlanceBlock',
						Boolean(match[2]) && match[2].includes('tick'),
						match[15] == '10',
						match[15] == '20',
						match[15] == '30',
					);
				});
		} else {
			return null;
		}
	}
}

export class DpsLog extends SimLog {
	readonly dps: number;

	// Damage events that occurred at the same time as this log.
	readonly damageLogs: Array<DamageDealtLog>;

	constructor(params: SimLogParams, dps: number, damageLogs: Array<DamageDealtLog>) {
		super(params);
		this.dps = dps;
		this.damageLogs = damageLogs;
	}

	static DPS_WINDOW = 15; // Window over which to calculate DPS.
	static fromLogs(damageDealtLogs: Array<DamageDealtLog>): Array<DpsLog> {
		const groupedDamageLogs = SimLog.groupDuplicateTimestamps(damageDealtLogs);

		let curDamageLogs: Array<DamageDealtLog> = [];
		let curDamageTotal = 0;

		return groupedDamageLogs.map(ddLogGroup => {
			ddLogGroup.forEach(ddLog => {
				curDamageLogs.push(ddLog);
				curDamageTotal += ddLog.amount;
			});

			const newStartIdx = curDamageLogs.findIndex(curLog => {
				const inWindow = curLog.timestamp > ddLogGroup[0].timestamp - DpsLog.DPS_WINDOW;
				if (!inWindow) {
					curDamageTotal -= curLog.amount;
				}
				return inWindow;
			});
			if (newStartIdx == -1) {
				curDamageLogs = [];
			} else {
				curDamageLogs = curDamageLogs.slice(newStartIdx);
			}

			const dps = curDamageTotal / DpsLog.DPS_WINDOW;
			if (isNaN(dps)) {
				console.warn('NaN dps!');
			}

			return new DpsLog(
				{
					raw: '',
					logIndex: ddLogGroup[0].logIndex,
					timestamp: ddLogGroup[0].timestamp,
					source: ddLogGroup[0].source,
					target: null,
					actionId: null,
					spellSchool: ddLogGroup[0].spellSchool,
					threat: 0,
				},
				dps,
				ddLogGroup,
			);
		});
	}
}

export class ThreatLogGroup extends SimLog {
	readonly threatBefore: number;
	readonly threatAfter: number;
	readonly logs: Array<SimLog>;

	constructor(params: SimLogParams, threatBefore: number, threatAfter: number, logs: Array<SimLog>) {
		super(params);
		this.threatBefore = threatBefore;
		this.threatAfter = threatAfter;
		this.logs = logs;
	}

	static fromLogs(logs: Array<SimLog>): Array<ThreatLogGroup> {
		const groupedLogs = SimLog.groupDuplicateTimestamps(logs.filter(log => log.threat != 0));
		let curThreat = 0;
		return groupedLogs.map(logGroup => {
			const newThreat = sum(logGroup.map(log => log.threat));
			const threatLog = new ThreatLogGroup(
				{
					raw: '',
					logIndex: logGroup[0].logIndex,
					timestamp: logGroup[0].timestamp,
					source: logGroup[0].source,
					target: logGroup[0].target,
					actionId: null,
					spellSchool: logGroup[0].spellSchool,
					threat: newThreat,
				},
				curThreat,
				curThreat + newThreat,
				logGroup,
			);

			curThreat += newThreat;
			return threatLog;
		});
	}
}

export class AuraEventLog extends SimLog {
	readonly isGained: boolean;
	readonly isFaded: boolean;
	readonly isRefreshed: boolean;

	constructor(params: SimLogParams, isGained: boolean, isFaded: boolean, isRefreshed: boolean) {
		super(params);
		this.isGained = isGained;
		this.isFaded = isFaded;
		this.isRefreshed = isRefreshed;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)}
				{`  Aura  `}
				{this.isGained ? 'gained' : this.isFaded ? 'faded' : 'refreshed'}: {this.newActionIdLink(true)}.
			</>
		));
	}

	static parse(params: SimLogParams): Promise<AuraEventLog> | null {
		const match = params.raw.match(/Aura ((gained)|(faded)|(refreshed)): (.*)/);
		if (match && match[5]) {
			return ActionId.fromLogString(match[5])
				.fill(params.source?.index)
				.then(aura => {
					params.actionId = aura;
					const event = match[1];
					return new AuraEventLog(params, event == 'gained', event == 'faded', event == 'refreshed');
				});
		} else {
			return null;
		}
	}
}

export class AuraStacksChangeLog extends SimLog {
	readonly oldStacks: number;
	readonly newStacks: number;

	constructor(params: SimLogParams, oldStacks: number, newStacks: number) {
		super(params);
		this.oldStacks = oldStacks;
		this.newStacks = newStacks;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} {this.newActionIdLink(true)} stacks: {this.oldStacks} &rarr; {this.newStacks}.
			</>
		));
	}

	static parse(params: SimLogParams): Promise<AuraStacksChangeLog> | null {
		const match = params.raw.match(/(.*) stacks: ([0-9]+) --> ([0-9]+)/);
		if (match && match[1]) {
			return ActionId.fromLogString(match[1])
				.fill(params.source?.index)
				.then(aura => {
					params.actionId = aura;
					return new AuraStacksChangeLog(params, parseInt(match[2]), parseInt(match[3]));
				});
		} else {
			return null;
		}
	}
}

export class AuraUptimeLog extends SimLog {
	readonly gainedAt: number;
	readonly fadedAt: number;
	readonly stacksChange: Array<AuraStacksChangeLog>;

	constructor(params: SimLogParams, fadedAt: number, stacksChange: Array<AuraStacksChangeLog>) {
		super(params);
		this.gainedAt = params.timestamp;
		this.fadedAt = fadedAt;
		this.stacksChange = stacksChange;
	}

	static fromLogs(logs: Array<SimLog>, entity: Entity, encounterDuration: number): Array<AuraUptimeLog> {
		const unmatchedGainedLogs: Array<{ gained: AuraEventLog; stacks: Array<AuraStacksChangeLog> }> = [];
		const uptimeLogs: Array<AuraUptimeLog> = [];

		logs.forEach((log: SimLog) => {
			if (!log.source || !log.source.equals(entity)) {
				return;
			}

			if (log.isAuraStacksChange()) {
				if (log.newStacks <= 0) {
					return;
				}
				const matchingGainedIdx = unmatchedGainedLogs.findIndex(
					gainedLog => gainedLog.gained.actionId!.equals(log.actionId!) || gainedLog.gained.actionId!.equalsIgnoringTag(log.actionId!),
				);
				if (matchingGainedIdx == -1) {
					console.warn('Unmatched aura stacks change log: ' + log.actionId!.name);
					return;
				}
				unmatchedGainedLogs[matchingGainedIdx].stacks.push(log);
				return;
			}

			if (!log.isAuraEvent()) {
				return;
			}

			if (log.isGained) {
				unmatchedGainedLogs.push({ gained: log, stacks: [] });
				return;
			}

			const matchingGainedIdx = unmatchedGainedLogs.findIndex(
				gainedLog => gainedLog.gained.actionId!.equals(log.actionId!) || gainedLog.gained.actionId!.equalsIgnoringTag(log.actionId!),
			);
			if (matchingGainedIdx == -1) {
				console.warn('Unmatched aura faded log: ' + log.actionId!.name);
				return;
			}
			const { gained: gainedLog, stacks: stacksChangeLogs } = unmatchedGainedLogs.splice(matchingGainedIdx, 1)[0];

			uptimeLogs.push(
				new AuraUptimeLog(
					{
						raw: log.raw,
						logIndex: gainedLog.logIndex,
						timestamp: gainedLog.timestamp,
						source: log.source,
						target: log.target,
						actionId: gainedLog.actionId,
						spellSchool: log.spellSchool,
						threat: gainedLog.threat,
					},
					log.timestamp,
					stacksChangeLogs,
				),
			);

			if (log.isRefreshed) {
				unmatchedGainedLogs.push({ gained: log, stacks: [] });
			}
		});

		// Auras active at the end won't have a faded log, so need to add them separately.
		unmatchedGainedLogs.forEach(unmatchedLog => {
			const { gained: gainedLog, stacks: stacksChangeLogs } = unmatchedLog;
			uptimeLogs.push(
				new AuraUptimeLog(
					{
						raw: gainedLog.raw,
						logIndex: gainedLog.logIndex,
						timestamp: gainedLog.timestamp,
						source: gainedLog.source,
						target: gainedLog.target,
						actionId: gainedLog.actionId,
						spellSchool: gainedLog.spellSchool,
						threat: gainedLog.threat,
					},
					encounterDuration,
					stacksChangeLogs,
				),
			);
		});

		uptimeLogs.sort((a, b) => a.gainedAt - b.gainedAt);
		return uptimeLogs;
	}

	// Populates the activeAuras field for all logs using the provided auras.
	static populateActiveAuras(logs: Array<SimLog>, auraLogs: Array<AuraUptimeLog>) {
		let curAuras: Array<AuraUptimeLog> = [];
		let auraLogsIndex = 0;

		logs.forEach(log => {
			while (auraLogsIndex < auraLogs.length && auraLogs[auraLogsIndex].gainedAt <= log.timestamp) {
				curAuras.push(auraLogs[auraLogsIndex]);
				auraLogsIndex++;
			}
			curAuras = curAuras.filter(curAura => curAura.fadedAt > log.timestamp);

			const activeAuras = curAuras.slice();
			activeAuras.sort((a, b) => stringComparator(a.actionId!.name, b.actionId!.name));
			log.activeAuras = activeAuras;
		});
	}
}

export class ResourceChangedLog extends SimLog {
	readonly resourceType: ResourceType;
	readonly valueBefore: number;
	readonly valueAfter: number;
	readonly isSpend: boolean;
	readonly total: number;
	readonly secondaryResourceType?: SecondaryResourceType;

	constructor(
		params: SimLogParams,
		resourceType: ResourceType,
		valueBefore: number,
		valueAfter: number,
		isSpend: boolean,
		total: number,
		secondaryType?: SecondaryResourceType,
	) {
		super(params);
		this.resourceType = resourceType;
		this.valueBefore = valueBefore;
		this.valueAfter = valueAfter;
		this.isSpend = isSpend;
		this.total = total;
		this.secondaryResourceType = secondaryType;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => {
			const signedDiff = (this.valueAfter - this.valueBefore) * (this.isSpend ? -1 : 1);
			const isHealth = this.resourceType == ResourceType.ResourceTypeHealth;
			const verb = isHealth ? (this.isSpend ? 'Lost' : 'Recovered') : this.isSpend ? 'Spent' : 'Gained';
			const resourceName =
				this.secondaryResourceType !== undefined ? SECONDARY_RESOURCES.get(this.secondaryResourceType)!.name : resourceNames.get(this.resourceType)!;
			const resourceClass = `resource-${resourceName.replace(/\s/g, '-').toLowerCase()}`;

			return (
				<>
					{this.toPrefix(includeTimestamp)} {verb}{' '}
					<strong className={resourceClass}>
						{signedDiff.toFixed(1)} {resourceName}
					</strong>
					{` from `}
					{this.newActionIdLink()}. ({this.valueBefore.toFixed(1)} &rarr; {this.valueAfter.toFixed(1)})
				</>
			);
		});
	}

	resultString(): string {
		const delta = this.valueAfter - this.valueBefore;
		if (delta < 0) {
			return delta.toFixed(1);
		} else {
			return '+' + delta.toFixed(1);
		}
	}

	static parse(params: SimLogParams): Promise<ResourceChangedLog> | null {
		const match = params.raw.match(/(Gained|Spent) (\d+\.?\d*) (\S.+?\S) from (.*?) \((\d+\.?\d*) --> (\d+\.?\d*)\)( of (\d+\.?\d*) total)?/);
		if (match) {
			const [resourceType, secondaryType] = stringToResourceType(match[3]);
			const total = match[8] !== undefined ? parseFloat(match[8]) : 0;
			return ActionId.fromLogString(match[4])
				.fill(params.source?.index)
				.then(cause => {
					params.actionId = cause;
					return new ResourceChangedLog(params, resourceType, parseFloat(match[5]), parseFloat(match[6]), match[1] == 'Spent', total, secondaryType);
				});
		} else {
			return null;
		}
	}
}

export class ResourceChangedLogGroup extends SimLog {
	readonly resourceType: ResourceType;
	readonly valueBefore: number;
	readonly valueAfter: number;
	readonly maxValue: number;
	readonly logs: Array<ResourceChangedLog>;

	constructor(params: SimLogParams, resourceType: ResourceType, valueBefore: number, valueAfter: number, maxValue: number, logs: Array<ResourceChangedLog>) {
		super(params);
		this.resourceType = resourceType;
		this.valueBefore = valueBefore;
		this.valueAfter = valueAfter;
		this.maxValue = maxValue;
		this.logs = logs;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} {resourceNames.get(this.resourceType)}: {this.valueBefore.toFixed(1)} &rarr; {this.valueAfter.toFixed(1)}
			</>
		));
	}

	static fromLogs(logs: Array<SimLog>): Record<ResourceType, Array<ResourceChangedLogGroup>> {
		const allResourceChangedLogs = logs.filter((log): log is ResourceChangedLog => log.isResourceChanged());

		const maxResource = function (logs: ResourceChangedLog[]) {
			let max = 0;
			logs.forEach(l => {
				if (l.total > max) {
					max = l.total;
				}
			});
			return max;
		};
		const results: Partial<Record<ResourceType, Array<ResourceChangedLogGroup>>> = {};
		const resourceTypes = (getEnumValues(ResourceType) as Array<ResourceType>).filter(val => val != ResourceType.ResourceTypeNone);
		resourceTypes.forEach(resourceType => {
			const resourceChangedLogs = allResourceChangedLogs.filter(log => log.resourceType == resourceType);

			const groupedLogs = SimLog.groupDuplicateTimestamps(resourceChangedLogs);
			results[resourceType] = groupedLogs.map(
				logGroup =>
					new ResourceChangedLogGroup(
						{
							raw: '',
							logIndex: logGroup[0].logIndex,
							timestamp: logGroup[0].timestamp,
							source: logGroup[0].source,
							target: logGroup[0].target,
							actionId: null,
							spellSchool: logGroup[0].spellSchool,
							threat: 0,
						},
						resourceType,
						logGroup[0].valueBefore,
						logGroup[logGroup.length - 1].valueAfter,
						maxResource(logGroup),
						logGroup,
					),
			);
		});

		return results as Record<ResourceType, Array<ResourceChangedLogGroup>>;
	}
}

export class MajorCooldownUsedLog extends SimLog {
	constructor(params: SimLogParams) {
		super(params);
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} Major cooldown used: {this.newActionIdLink()}.
			</>
		));
	}

	static parse(params: SimLogParams): Promise<MajorCooldownUsedLog> | null {
		const match = params.raw.match(/Major cooldown used: (.*)/);
		if (match) {
			return ActionId.fromLogString(match[1])
				.fill(params.source?.index)
				.then(cooldownId => {
					params.actionId = cooldownId;
					return new MajorCooldownUsedLog(params);
				});
		} else {
			return null;
		}
	}
}

export class CastBeganLog extends SimLog {
	readonly manaCost: number;
	readonly castTime: number;
	readonly effectiveTime: number;

	constructor(params: SimLogParams, manaCost: number, castTime: number, effectiveTime: number) {
		super(params);
		this.manaCost = manaCost;
		this.castTime = castTime;
		this.effectiveTime = effectiveTime;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} Casting {this.newActionIdLink()} (Cast time: {this.castTime.toFixed(2)}s, Cost: {this.manaCost.toFixed(1)}{' '}
				Mana).
			</>
		));
	}

	static parse(params: SimLogParams): Promise<CastBeganLog> | null {
		const match = params.raw.match(/Casting (.*) \(Cost = (\d+\.?\d*), Cast Time = (\d+\.?\d*)(m?s), Effective Time = (\d+\.?\d*)(m?s)\)/);
		if (match) {
			let castTime = parseFloat(match[3]);
			if (match[4] == 'ms') {
				castTime /= 1000;
			}
			let effectiveTime = parseFloat(match[5]);
			if (match[6] == 'ms') {
				effectiveTime /= 1000;
			}
			return ActionId.fromLogString(match[1])
				.fill(params.source?.index)
				.then(castId => {
					params.actionId = castId;
					return new CastBeganLog(params, parseFloat(match[2]), castTime, effectiveTime);
				});
		} else {
			return null;
		}
	}
}

export class CastCompletedLog extends SimLog {
	constructor(params: SimLogParams) {
		super(params);
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} Completed cast {this.actionId!.name}.
			</>
		));
	}

	static parse(params: SimLogParams): Promise<CastCompletedLog> | null {
		const match = params.raw.match(/Completed cast (.*)/);
		if (match) {
			return ActionId.fromLogString(match[1])
				.fill(params.source?.index)
				.then(castId => {
					params.actionId = castId;
					return new CastCompletedLog(params);
				});
		} else {
			return null;
		}
	}
}

export class CastLog extends SimLog {
	readonly castTime: number;
	readonly effectiveTime: number;
	readonly travelTime: number;

	readonly castBeganLog: CastBeganLog;
	readonly castCompletedLog: CastCompletedLog | null;

	// All instances of damage dealt from the completion of this cast until the completion of the next cast.
	readonly damageDealtLogs: Array<DamageDealtLog>;

	constructor(castBeganLog: CastBeganLog, castCompletedLog: CastCompletedLog | null, damageDealtLogs: Array<DamageDealtLog>) {
		super({
			raw: castBeganLog.raw,
			logIndex: castBeganLog.logIndex,
			timestamp: castBeganLog.timestamp,
			source: castBeganLog.source,
			target: castBeganLog.target,
			actionId: castCompletedLog?.actionId || castBeganLog.actionId, // Use completed log because of arcane blast
			spellSchool: castCompletedLog?.spellSchool || castBeganLog.spellSchool,
			threat: castCompletedLog?.threat || castBeganLog.threat,
		});
		this.castTime = castBeganLog.castTime;
		this.effectiveTime = castBeganLog.effectiveTime;
		this.castBeganLog = castBeganLog;
		this.castCompletedLog = castCompletedLog;
		this.damageDealtLogs = damageDealtLogs;

		if (this.castCompletedLog && this.castBeganLog) {
			this.castTime = this.castCompletedLog.timestamp - this.castBeganLog.timestamp;
			this.effectiveTime = this.castCompletedLog.timestamp - this.castBeganLog.timestamp;
		}
		if (
			this.castCompletedLog &&
			this.damageDealtLogs.length == 1 &&
			this.castCompletedLog.timestamp < this.damageDealtLogs[0].timestamp &&
			!this.damageDealtLogs[0].tick
		) {
			this.travelTime = this.damageDealtLogs[0].timestamp - this.castCompletedLog.timestamp;
		} else {
			this.travelTime = 0;
		}
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => (
			<>
				{this.toPrefix(includeTimestamp)} Casting {this.actionId!.name} (Cast time = {this.castTime.toFixed(2)}s).
			</>
		));
	}

	totalDamage(): number {
		return sum(this.damageDealtLogs.map(ddl => ddl.amount));
	}

	static fromLogs(logs: Array<SimLog>): Array<CastLog> {
		const castBeganLogs = logs.filter((log): log is CastBeganLog => log.isCastBegan());
		const castCompletedLogs = logs.filter((log): log is CastCompletedLog => log.isCastCompleted());
		const damageDealtLogs = logs.filter((log): log is DamageDealtLog => log.isDamageDealt());

		const toBucketKey = (actionId: ActionId) => {
			if (actionId.spellId == 30451 || actionId.spellId == 127632) {
				// Arcane Blast is unique because it can finish its cast as a different
				// spell than it started (if stacks drop).
				// Also handle Shadow's Cascade for bouncing
				return actionId.toStringIgnoringTag();
			} else {
				return actionId.toString();
			}
		};
		const castBeganLogsByAbility = bucket(castBeganLogs, log => toBucketKey(log.actionId!));
		const castCompletedLogsByAbility = bucket(castCompletedLogs, log => toBucketKey(log.actionId!));
		const damageDealtLogsByAbility = bucket(damageDealtLogs, log => toBucketKey(log.actionId!));

		const castLogs: Array<CastLog> = [];
		Object.keys(castBeganLogsByAbility).forEach(bucketKey => {
			const abilityCastsBegan = castBeganLogsByAbility[bucketKey]!;
			const abilityCastsCompleted = castCompletedLogsByAbility[bucketKey];
			const abilityDamageDealt = damageDealtLogsByAbility[bucketKey];

			let ddIdx = 0;
			for (let cbIdx = 0; cbIdx < abilityCastsBegan.length; cbIdx++) {
				const cbLog = abilityCastsBegan[cbIdx];

				// Assume cast completed log is the same index because they always come in pairs.
				// Only exception is final pair, where there might be a cast began without a cast completed.
				let ccLog: CastCompletedLog | null = null;
				let nextCcLog: CastCompletedLog | null = null;
				if (abilityCastsCompleted && cbIdx < abilityCastsCompleted.length) {
					ccLog = abilityCastsCompleted[cbIdx];
					if (cbIdx + 1 < abilityCastsCompleted.length) {
						nextCcLog = abilityCastsCompleted[cbIdx + 1];
					}
				}

				// Find all damage dealt logs between the cur and next cast completed logs.
				const ddLogs = [];
				while (abilityDamageDealt && ddIdx < abilityDamageDealt.length && (!nextCcLog || abilityDamageDealt[ddIdx].timestamp < nextCcLog.timestamp)) {
					ddLogs.push(abilityDamageDealt[ddIdx]);
					ddIdx++;
				}
				castLogs.push(new CastLog(cbLog, ccLog, ddLogs));
			}
		});

		castLogs.sort((a, b) => a.timestamp - b.timestamp);
		return castLogs;
	}
}

export class StatChangeLog extends SimLog {
	readonly isGain: boolean;
	readonly stats: string;

	constructor(params: SimLogParams, isGain: boolean, stats: string) {
		super(params);
		this.isGain = isGain;
		this.stats = stats;
	}

	toHTML(includeTimestamp = true) {
		return this.cacheOutput(includeTimestamp, () => {
			if (this.isGain) {
				return (
					<>
						{this.toPrefix(includeTimestamp)} Gained {this.stats} from {this.newActionIdLink()}.
					</>
				);
			} else {
				return (
					<>
						{this.toPrefix(includeTimestamp)} Lost {this.stats} from fading {this.newActionIdLink()}.
					</>
				);
			}
		});
	}

	static parse(params: SimLogParams): Promise<StatChangeLog> | null {
		const match = params.raw.match(/((Gained)|(Lost)) ({.*}) from (fading )?(.*)/);
		if (match) {
			return ActionId.fromLogString(match[6])
				.fill(params.source?.index)
				.then(effectId => {
					params.actionId = effectId;
					const sign = match[1] == 'Lost' ? -1 : 1;
					return new StatChangeLog(params, sign == 1, match[4]);
				});
		} else {
			return null;
		}
	}
}
