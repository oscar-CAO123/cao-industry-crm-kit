// Shared shapes for the condition-report workflow. Field names come only from the Reapit Foundations docs:
// the paging envelope (_embedded, totalCount) and the contact fields (id, forename, surname, email, mobilePhone)
// are confirmed there. A property's payload is confirmed only as far as its id, so only the id is read.

export interface Settings { business_name?: string }

export interface Page<T> { pageNumber?: number; totalPageCount?: number; totalCount?: number; _embedded?: T[] | null }
export interface Property { id: string }
export interface Contact { id: string; forename?: string; surname?: string; email?: string; mobilePhone?: string }

/** An id from the platform is checked before it becomes a store key, so a hostile value cannot reach a path or a filter. */
export const ID = /^[A-Za-z0-9._-]{1,64}$/;
